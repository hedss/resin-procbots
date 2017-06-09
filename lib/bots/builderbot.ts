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

// BuilderBot listens for merges of a PR to the `master` branch and then
// updates any packages for it.
import * as Promise from 'bluebird';
import * as ChildProcess from 'child_process';
import * as GithubApi from 'github';
import * as path from 'path';
import { track } from 'temp';
import * as GithubApiTypes from '../apis/githubapi-types';
import { ProcBot } from '../framework/procbot';
import { GithubCookedData, GithubHandle, GithubRegistration } from '../services/github-types';
import { ServiceEvent } from '../services/service-types';
import { LogLevel } from '../utils/logger';

const exec: (command: string, options?: any) => Promise<{}> = Promise.promisify(ChildProcess.exec);
const tempMkdir = Promise.promisify(track().mkdir);
// const tempCleanup = Promise.promisify(cleanup);

export class BuilderBot extends ProcBot {
    /** Github ServiceListener. */
    private githubListenerName: string;
    /** Github ServiceEmitter. */
    private githubEmitterName: string;
    /** Instance of Github SDK API in use. */
    private githubApi: GithubApi;

    /**
     * Constructs a new BuilderBot instance.
     * @param integration Github App ID.
     * @param name        Name of the BuilderBot.
     * @param pemString   PEM for Github events and App login.
     * @param webhook     Secret webhook for validating events.
     */
    constructor(integration: number, name: string, pemString: string, webhook: string) {
        // This is the BuilderBot.
        super(name);

        // Create a new listener for Github with the right Integration ID.
        const ghListener = this.addServiceListener('github', {
            client: name,
            loginType: {
                integrationId: integration,
                pem: pemString,
                type: 'integration'
            },
            path: '/builderhooks',
            port: 9898,
            type: 'listener',
            webhookSecret: webhook
        });

        // Create a new emitter with the right Integration ID.
        const ghEmitter = this.addServiceEmitter('github', {
            loginType: {
                integrationId: integration,
                pem: pemString,
                type: 'integration'
            },
            pem: pemString,
            type: 'emitter'
        });

        // Throw if we didn't get either of the services.
        if (!ghListener) {
            throw new Error("Couldn't create a Github listener");
        }
        if (!ghEmitter) {
            throw new Error("Couldn't create a Github emitter");
        }
        this.githubListenerName = ghListener.serviceName;
        this.githubEmitterName = ghEmitter.serviceName;

        // Github API handle
        this.githubApi = (<GithubHandle>ghEmitter.apiHandle).github;
        if (!this.githubApi) {
            throw new Error('No Github API instance found');
        }

        ghListener.registerEvent({
            events: [ 'push' ],
            listenerMethod: this.buildCode,
            name: 'BuildCode'
        });
    }

    protected buildCode = (_registration: GithubRegistration, event: ServiceEvent): Promise<void> => {
        const cookedData: GithubCookedData = event.cookedEvent;
        const authToken = cookedData.githubAuthToken;
        const pushEvent: GithubApiTypes.PushEvent = event.cookedEvent.data;
        const repo = pushEvent.repository;
        const fullName = repo.full_name;
        const owner = repo.owner.login;
        const repoName = repo.name;
        const branchRef = pushEvent.ref;
        const cliCommand = (command: string) => {
            return exec(command, { cwd: fullPath });

        };
        let fullPath = '';
        this.logger.log(LogLevel.INFO, `Received a push event from the ${branchRef} of ${owner}/${repoName}`);

        // Clone the repo into a temporary directory.
        return tempMkdir(`${owner}-${repoName}`).then((tempDir) => {
            fullPath = `${tempDir}${path.sep}`;
            this.logger.log(LogLevel.INFO, `Cloning into ${fullPath}`);

            return Promise.mapSeries([
                `git clone https://${authToken}:${authToken}@github.com/${fullName} ${fullPath}`,
                `git checkout ${branchRef}`
            ], cliCommand);
        }).then(() => {
            // Now get a tar stream of it to send to the builder.
            // The repo is in the `fullPath` directory.
        }).then(() => {
            // Send to builder.

            // Bin the directory.
        }); // .finally(tempCleanup);
    }
}

/**
 * Creates a new instance of the BuilderBot client.
 */
export function createBot(): BuilderBot {
    if (!(process.env.BUILDERBOT_NAME && process.env.BUILDERBOT_INTEGRATION_ID &&
    process.env.BUILDERBOT_PEM && process.env.BUILDERBOT_WEBHOOK_SECRET)) {
        throw new Error(`'BUILDERBOT_NAME', 'BUILDERBOT_INTEGRATION_ID', 'BUILDERBOT_PEM' and ` +
            `'BUILDERBOT_WEBHOOK_SECRET environment variables need setting`);
    }

    return new BuilderBot(process.env.BUILDERBOT_INTEGRATION_ID, process.env.BUILDERBOT_NAME,
    process.env.BUILDERBOT_PEM, process.env.BUILDERBOT_WEBHOOK_SECRET);
}
