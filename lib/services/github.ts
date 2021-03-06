/*
Copyright 2016-2017 Resin.io

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
/* tslint:disable: max-classes-per-file */
import * as Promise from 'bluebird';
import * as bodyParser from 'body-parser';
import * as crypto from 'crypto';
import * as express from 'express';
import * as GithubApi from 'github';
import * as jwt from 'jsonwebtoken';
import * as _ from 'lodash';
import * as path from 'path';
import * as request from 'request-promise';
import TypedError = require('typed-error');
import { Worker, WorkerEvent } from '../framework/worker';
import { WorkerClient } from '../framework/worker-client';
import { AlertLevel, Logger, LogLevel } from '../utils/logger';
import { GithubConstructor, GithubEmitRequestContext, GithubHandle, GithubIntegration,
    GithubListenerConstructor, GithubRegistration } from './github-types';
import { ServiceEmitContext, ServiceEmitRequest, ServiceEmitResponse, ServiceEmitter,
    ServiceEvent, ServiceListener } from './service-types';

/** Github label interface. */
interface LabelDetails {
    /** The PR or issue number. */
    number: string;
    /** Repository information. */
    repo: {
        /** Owner of the repository. */
        owner: {
            login: string;
        };
        /** Name of the repository. */
        name: string;
    };
}

/** Github Error. */
export class GithubError extends TypeError {
    /** Message error from the Github API. */
    public message: string;
    /** Documentation URL pertaining to the error. */
    public documentationUrl: string;

    /** Should the error returned not be from the Github API but from the
     * REST layer, then the message from it is used instead.
     */
    constructor(error: any) {
        super(error);

        // Attempt to parse from JSON.
        try {
            const data = JSON.parse(error.message);
            this.message = data.message;
            this.documentationUrl = data.documentation_url;
        } catch (_err) {
            this.message = error.message;
            this.documentationUrl = '';
        }
    }
}

/**
 * The Github service allows all interaction with Github.
 * It implements both a ServiceListener that listens to webhooks and a ServiceEmitter
 * that communicates with GH via its API.
 */
export class GithubService extends WorkerClient<string> implements ServiceListener, ServiceEmitter {
    protected getWorker: (event: WorkerEvent) => Worker<string>;
    protected authToken: string;
    protected pem: string;
    protected githubApi: any;
    private integrationId: number;
    private eventTriggers: GithubRegistration[] = [];
    // This is the current voodoo to allow all API calls to succeed.
    // Accept: 'application/vnd.github.black-cat-preview+json' is now out of date
    private ghApiAccept = 'application/vnd.github.loki-preview+json';
    private _serviceName = path.basename(__filename.split('.')[0]);
    private logger = new Logger();

    /**
     * Constructor for both the ServiceListener and ServiceEmitter.
     * @param constObj  Construction object for either ServiceListener or ServiceEmitter.
     */
    constructor(constObj: GithubListenerConstructor | GithubConstructor) {
        super();

        // Determine type of service.
        if (constObj.loginType.type !== 'integration') {
            throw new Error('Do not yet support non-Integration type clients');
        }
        constObj.loginType = <GithubIntegration>constObj.loginType;

        // Set the Integration ID.
        this.integrationId = constObj.loginType.integrationId;
        this.pem = constObj.loginType.pem;

        // The `github` module is a bit behind the preview API. We may have to override
        // some of the methods here (PR review comments for a start).
        // Both the listener and the emitter need access to the API.
        this.githubApi = new GithubApi({
            Promise: <any>Promise,
            headers: {
                Accept: this.ghApiAccept
            },
            host: 'api.github.com',
            protocol: 'https',
            timeout: 20000
        });
        this.authenticate();

        // Only the listener deals with events.
        if (constObj.type === 'listener') {
            const listenerConstructor = <GithubListenerConstructor>constObj;

            // The getWorker method is an overload for generic context types.
            // In the case of the GithubBot, it's the name of the repo (a string).
            this.getWorker = (event: WorkerEvent): Worker<string> => {
                const repository = event.data.rawEvent.repository;
                let context = '';

                // If there's a repository, we use the full name as the context,
                // else we use a generic. Generic contexts can occur on events that
                // are not linked to a repo (adding/removing repo from Integration,
                // creating a user, deleting a user, etc.)
                if (repository) {
                    context = repository.full_name;
                } else {
                    context = 'generic';
                }
                let worker: Worker<string> | undefined = this.workers.get(context);

                // If we already have a worker for this context (the repo name), return it.
                if (worker) {
                    return worker;
                }

                // Create new Worker using the repo name as context.
                // We currently just use Procbot's removal method.
                worker = new Worker(context, this.removeWorker);

                // Note that workers are self-regualting; that is, they will remove themselves
                // from the Map once there are no more queued tasks.
                this.workers.set(context, worker);

                return worker;
            };

            // Verify that events being sent our way are valid and authenticated.
            function verifyWebhookToken(payload: string, hubSignature: string): boolean {
                const newHmac: any = crypto.createHmac('sha1', listenerConstructor.webhookSecret);
                newHmac.update(payload);
                if (('sha1=' + newHmac.digest('hex')) === hubSignature) {
                    return true;
                }

                return false;
            }

            // Standard Express installation.
            const app = express();
            app.use(bodyParser.urlencoded({ extended: true }));
            app.use(bodyParser.json());

            // Listen for Webhooks on the path specified by the client.
            app.post(listenerConstructor.path, (req, res) => {
                const eventType: string = req.get('x-github-event');
                const payload = req.body;

                // Ensure that the sender is authorised and uses our secret.
                if (!verifyWebhookToken(JSON.stringify(payload), req.get('x-hub-signature'))) {
                    res.sendStatus(401);
                    return;
                }

                // Let the hook get on with it.
                res.sendStatus(200);

                // Add this event into our queue.
                this.queueEvent({
                    data: {
                        cookedEvent: {
                            data: payload,
                            githubAuthToken: this.authToken,
                            type: eventType
                        },
                        rawEvent: payload,
                        source: this._serviceName
                    },
                    workerMethod: this.handleGithubEvent
                });
            });

            // Listen on the specified port.
            app.listen(listenerConstructor.port, () => {
                this.logger.log(LogLevel.INFO, `---> ${listenerConstructor.client}: Listening Github Service on ` +
                    `':${listenerConstructor.port}${listenerConstructor.path}'`);
            });
        }
    }

    /**
     * Create a new event triggered action for the list.
     * @param registration  A GithubRegistration object detailing the events required by the client.
     */
    public registerEvent(registration: GithubRegistration): void {
        this.eventTriggers.push(registration);
    }

    /**
     * Send data to Github.
     * This method will automatically deal with paged requests. Should any passed data
     * reference the `per_page` or `page` properties, these will be honoured, else page
     * fetches will start at 0 with the default 30 entries per page
     * Fetches will occur until there are no pages left to fetch.
     * @param data  A ServiceEmitRequest detailling the call to make and associated data.
     * @return      A ServiceEmitResponse comprised from the response from Github.
     */
    public sendData(data: ServiceEmitRequest): Promise<ServiceEmitResponse> {
        // Try and find the context for the Github request.
        const emitContext: ServiceEmitContext = _.pickBy(data.contexts, (_val, key) => {
            return key === this._serviceName;
        });
        const githubContext: GithubEmitRequestContext = _.cloneDeep(emitContext.github);
        let retriesLeft = 3;
        let returnArray: any = [];
        let perPage = githubContext.data['per_page'] || 30;
        let page = githubContext.data.page || 1;

        // We need a new Promise here, as we might need to do retries.
        const runApi = (): Promise<ServiceEmitResponse> => {
            retriesLeft -= 1;

            // Run the method.
            return githubContext.method(githubContext.data).then((resData: any) => {
                let response = resData;

                // If the returned data is an array, check the number of results.
                // If the same length as `per_page`, then ask for another one.
                if (Array.isArray(resData)) {
                    returnArray = _.concat(returnArray, resData);
                    retriesLeft += 1;

                    // If there weren't page details previously, we now need to apply them
                    // to the next fetch.
                    // Then increase page number.
                    if (!githubContext.data.page) {
                        githubContext.data.page = page;
                    }
                    if (!githubContext.data['per_page']) {
                        githubContext.data['per_page'] = perPage;
                    }
                    githubContext.data.page++;

                    // Check to see if the last set of results was less than `per_page`.
                    // If not, get the next page.
                    if (resData.length === perPage) {
                        return runApi();
                    }

                    // Finally we filter for duplicates. We do this via URL.
                    response = _.uniqBy(returnArray, 'url');
                }

                // Else if not an array (or less entries then `per_page` returned), just
                // return the data.
                return {
                    response,
                    source: this._serviceName
                };
            }).catch((error: Error) => {
                // Sometimes the gateway can time out if we don't respond quickly enough.
                // This will destroy the ability to continue for this callset, so we exit.
                let err = new GithubError(error);
                if (err.message.indexOf('504: Gateway Timeout') !== -1) {
                    return {
                        err: new TypedError('Github API timed out, could not complete'),
                        source: this._serviceName
                    };
                } else {
                    // If there are no more retries, or we couldn't find the required
                    // details, reject.
                    if ((retriesLeft < 1) || (err.message === 'Not Found')) {
                        // No more retries, just reject.
                        return {
                            err: new TypedError(err),
                            source: this._serviceName
                        };
                    } else {
                        if (err.message === 'Bad credentials') {
                            // Re-authenticate, then try again.
                            return this.authenticate().then(runApi);
                        } else {
                            // If there's more retries, try again in 5 seconds.
                            return Promise.delay(5000).then(runApi);
                        }
                    }
                }
            });
        };

        return runApi();
    }

    /**
     * Get the name of the Github service.
     * @return  The name of the service.
     */
    get serviceName(): string {
        return this._serviceName;
    }

    /**
     * Retrieve the Github SDK API handle.
     * @return  Github SDK handle.
     */
    get apiHandle(): GithubHandle {
        return {
            github: this.githubApi
        };
    }

    /**
     * Handles all Github events to trigger actions, should the parameters meet those registered.
     * @param event A ServiceEvent created from the event sent by Github.
     * @return      Promise that is fulfilled once all processing of the event has completed.
     */
    protected handleGithubEvent = (event: ServiceEvent): Promise<void> => {
        // Determine the head to use based on the event.
        const labelHead = (): LabelDetails | void => {
            // Note that a label event itself is not in itself a labelled type,
            // so we don't check for it.
            switch (event.cookedEvent.type) {
                case 'issue_comment':
                case 'issues':
                    return {
                        number: event.rawEvent.issue.number,
                        repo: event.rawEvent.repository
                    };

                case 'pull_request':
                case 'pull_request_review':
                case 'pull_request_review_comment':
                    return {
                        number: event.rawEvent.pull_request.number,
                        repo: event.rawEvent.repository
                    };

                default:
                    return;
            }
        };

        return Promise.map(this.eventTriggers, (registration) => {
            // Is the event one of the type that triggers the action?
            if (_.includes(registration.events, event.cookedEvent.type)) {
                let labelEvent = labelHead();
                let labelPromise = Promise.resolve({source: this._serviceName});

                // Are there any labels (trigger or suppression) set on the action?
                if ((registration.triggerLabels || registration.suppressionLabels) && labelEvent) {
                    // OK, so we've got a label event, so we now have to get all the labels
                    // for the appropriate issue.
                    const request: ServiceEmitRequest = {
                        contexts: {},
                        source: this._serviceName
                    };
                    request.contexts[this._serviceName] = {
                        data: {
                            number: labelEvent.number,
                            owner: labelEvent.repo.owner.login,
                            repo: labelEvent.repo.name
                        },
                        method: this.githubApi.issues.getIssueLabels
                    };
                    labelPromise = this.sendData(request);
                }
                labelPromise.then((data: ServiceEmitResponse) => {
                    // If there are some labels, then we process them.
                    const labels = data.response;
                    if (labels) {
                        const foundLabels: string[] = labels.map((label: any) => {
                            return label.name;
                        });

                        // First, are all the suppression labels present?
                        if (registration.suppressionLabels &&
                            (_.intersection(registration.suppressionLabels, foundLabels).length ===
                            registration.suppressionLabels.length)) {
                            this.logger.log(LogLevel.DEBUG,
                                `Dropping '${registration.name}' as suppression labels are all present`);
                            return;
                        }
                        // Secondly, are all the trigger labels present?
                        if (registration.triggerLabels &&
                            (_.intersection(registration.triggerLabels, foundLabels).length !==
                            registration.triggerLabels.length)) {
                            this.logger.log(LogLevel.DEBUG,
                                `Dropping '${registration.name}' as not all trigger labels are present`);
                            return;
                        }
                    }

                    return registration.listenerMethod(registration, event);
                }).catch((err: Error) => {
                    // We log the error, so that it's saved and matches up with any Alert.
                    this.logger.alert(AlertLevel.ERROR, `Error thrown in main event/label filter loop:${err}`);
                });
            }
        }).return();
    }

    /**
     * Authenticate against the Github API and Installation environment (for Integrations).
     * @return  Promise fulfilled once authentication has occurred.
     */
    protected authenticate(): Promise<void> {
        // Initialise JWTs
        const privatePem = new Buffer(this.pem, 'base64').toString();
        const payload = {
            exp: Math.floor((Date.now() / 1000)) + (10 * 60),
            iat: Math.floor((Date.now() / 1000)),
            iss: this.integrationId
        };
        const jwToken = jwt.sign(payload, privatePem, { algorithm: 'RS256' });
        const installationsOpts = {
            headers: {
                'Accept': 'application/vnd.github.machine-man-preview+json',
                'Authorization': `Bearer ${jwToken}`,
                'User-Agent': 'request'
            },
            json: true,
            url: 'https://api.github.com/integration/installations'
        };

        return request.get(installationsOpts).then((installations) => {
            // Get the URL for the token.
            const tokenUrl = installations[0].access_tokens_url;

            // Request new token.
            const tokenOpts: any = {
                headers: {
                    'Accept': 'application/vnd.github.machine-man-preview+json',
                    'Authorization': `Bearer ${jwToken}`,
                    'User-Agent': 'request'
                },
                json: true,
                method: 'POST',
                url: tokenUrl
            };

            return request.post(tokenOpts);
        }).then((tokenDetails) => {
            // We also need to take into account the expiry date, which will require a new kickoff.
            this.authToken = tokenDetails.token;
            this.githubApi.authenticate({
                token: this.authToken,
                type: 'token'
            });

            // For debug.
            this.logger.log(LogLevel.INFO, `token for manual fiddling is: ${tokenDetails.token}`);
            this.logger.log(LogLevel.INFO, `token expires at: ${tokenDetails.expires_at}`);
            this.logger.log(LogLevel.INFO, 'Base curl command:');
            this.logger.log(LogLevel.INFO,
                `curl -XGET -H "Authorisation: token ${tokenDetails.token}" ` +
                `-H "Accept: ${this.ghApiAccept}" https://api.github.com/`);
        });
    }
}

/**
 * Create a new Github ServiceListener.
 * @param constObj  Constructor for the ServiceListener.
 * @return          A new instance of the ServiceListener.
 */
export function createServiceListener(constObj: GithubListenerConstructor): ServiceListener {
    return new GithubService(constObj);
}

/**
 * Create a new Github ServiceEmitter.
 * @param constObj  Constructor for the ServiceEmitter.
 * @return          A new instance of the ServiceEmitter.
 */
export function createServiceEmitter(constObj: GithubConstructor): ServiceEmitter {
    return new GithubService(constObj);
}
