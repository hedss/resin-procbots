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

import * as Promise from 'bluebird';
import { Session } from 'flowdock';
import * as _ from 'lodash';
import * as path from 'path';
import * as request from 'request-promise';
import {
    DataHub, MessengerEmitResponse, MessengerEvent, ReceiptContext, TransmitContext
} from '../utils/message-types';
import { FlowdockEmitContext, FlowdockHandle, FlowdockMessage } from './flowdock-types';
import { MessageService } from './message-service';
import { ServiceEmitter, ServiceListener } from './service-types';

export class FlowdockService extends MessageService implements ServiceEmitter, ServiceListener, DataHub {
    private static _serviceName = path.basename(__filename.split('.')[0]);
    private static session = new Session(process.env.FLOWDOCK_LISTENER_ACCOUNT_API_TOKEN);

    /**
     * Promise to turn the data enqueued into a generic message format.
     * @param data  Raw data from the enqueue, remembering this is as dumb and quick as possible.
     * @returns     A promise that resolves to the generic form of the event.
     */
    public makeGeneric(data: MessengerEvent): Promise<ReceiptContext> {
        // Separate out some parts of the message
        const metadata = MessageService.extractMetadata(data.rawEvent.content);
        const titleAndText = metadata.content.match(/^(.*)\n--\n((?:\r|\n|.)*)$/);
        const flow = data.cookedEvent.flow;
        const thread = data.rawEvent.thread_id;
        const userId = data.rawEvent.user;
        const org = process.env.FLOWDOCK_ORGANIZATION_NAME;
        const returnValue: ReceiptContext = {
            action: 'create',
            first: data.rawEvent.id === data.rawEvent.thread.initial_message,
            genesis: metadata.genesis || data.source,
            hidden: metadata.hidden,
            source: data.source,
            sourceIds: {
                message: data.rawEvent.id,
                flow,
                thread,
                url: `https://www.flowdock.com/app/${org}/${flow}/threads/${thread}`,
                user: 'duff', // gets replaced
            },
            text: titleAndText ? titleAndText[2] : metadata.content,
            title: titleAndText ? titleAndText[1] : undefined,
        };
        // If the data provided a username
        if (data.rawEvent.external_user_name) {
            returnValue.sourceIds.user = data.rawEvent.external_user_name;
            return Promise.resolve(returnValue);
        }
        // Attempt to find a username by id
        return this.fetchFromSession(`/organizations/${org}/users/${userId}`)
        .then((user) => {
            returnValue.sourceIds.user = user.nick;
            return returnValue;
        });
    }

    /**
     * Promise to turn the generic message format into a specific form to be emitted.
     * @param data  Generic message format object to be encoded.
     * @returns     Promise that resolves to the emit suitable form.
     */
    public makeSpecific(data: TransmitContext): Promise<FlowdockEmitContext> {
        // Build a string for the title, if appropriate.
        const titleText = data.first && data.title ? data.title + '\n--\n' : '';
        return Promise.resolve({
            // The concatenated string, of various data nuggets, to emit
            content: MessageService.stringifyMetadata(data) + titleText + data.text,
            event: 'message',
            external_user_name:
                // If this is using the generic token, then they must be an external user, so indicate this
                data.toIds.token === process.env.FLOWDOCK_LISTENER_ACCOUNT_API_TOKEN
                ? data.toIds.user.substring(0, 16) : undefined,
            flow: data.toIds.flow,
            thread_id: data.toIds.thread,
            token: data.toIds.token,
        } as FlowdockEmitContext);
    }

    /**
     * Turns the generic, messenger, name for an event into a specific trigger name for this class.
     * @param eventType  Name of the event to translate, eg 'message'.
     * @returns          This class's equivalent, eg 'post'.
     */
    public translateEventName(eventType: string): string {
        const equivalents: {[key: string]: string} = {
            message: 'message',
        };
        return equivalents[eventType];
    }

    /**
     * Promise to find the comment history of a particular thread.
     * @param thread  id of the thread to search.
     * @param room    id of the room in which the thread resides.
     * @param filter  criteria to match.
     */
    public fetchNotes(thread: string, room: string, filter: RegExp): Promise<string[]> {
        // Query the API
        const org = process.env.FLOWDOCK_ORGANIZATION_NAME;
        return this.fetchFromSession(`/flows/${org}/${room}/threads/${thread}/messages`)
        .then((messages) => {
            return _.map(messages, (value: FlowdockMessage) => {
                // Clean the response to just the content
                return value.content;
            }).filter((value: string) => {
                // Filter the response to just matches
                const match = value.match(filter);
                return match !== null && match.length > 0;
            });
        });
    }

    /**
     * Search for the specified value associated with a user.
     * @param user  username to search associated with.
     * @param key   name of the value to retrieve.
     * @returns     Promise that resolves to the value.
     */
    public fetchValue(user: string, key: string): Promise<string> {
        // Retrieve a particular regex from the 1-1 message history of the user
        const findKey = new RegExp(`My ${key} is (\\S+)`, 'i');
        return this.fetchPrivateMessages(user, findKey).then((valueArray) => {
            const value = valueArray[valueArray.length - 1].match(findKey);
            if (value) { return value[1]; }
            throw new Error(`Could not find value $key for $user`);
        });
    }

    /**
     * Activate this service as a listener.
     */
    protected activateMessageListener(): void {
        // Get a list of known flows from the session
        FlowdockService.session.flows((error: any, flows: any) => {
            if (error) {
                throw error;
            }
            // Store the names and stream retrieved flows
            const flowIdToFlowName: {[key: string]: string} = {};
            for (const flow of flows) {
                flowIdToFlowName[flow.id] = flow.parameterized_name;
            }
            const stream = FlowdockService.session.stream(Object.keys(flowIdToFlowName));
            // Listen to messages and check they are messages
            stream.on('message', (message: any) => {
                if (message.event === 'message') {
                    // Enqueue new message events
                    this.queueEvent({
                        data: {
                            cookedEvent: {
                                context: message.thread_id,
                                flow: flowIdToFlowName[message.flow],
                                type: message.event,
                            },
                            rawEvent: message,
                            source: this.serviceName,
                        },
                        workerMethod: this.handleEvent,
                    });
                }
            });
        });
        // Create a keep-alive endpoint for contexts that sleep between web requests
        MessageService.app.get(`/${this.serviceName}/`, (_formData, response) => {
            response.send('ok');
        });
    }

    /**
     * Deliver the payload to the service. Sourcing the relevant context has already been performed.
     * @param data  The object to be delivered to the service.
     * @returns     Response from the service endpoint.
     */
    protected sendPayload(data: FlowdockEmitContext): Promise<MessengerEmitResponse> {
        const body = _.cloneDeep(data);
        // Extract a couple of details from the environment
        const org = process.env.FLOWDOCK_ORGANIZATION_NAME;
        const token = new Buffer(data.token).toString('base64');
        delete body.token;
        // Post to the API
        const requestOpts = {
            body,
            headers: {
                'Authorization': `Basic ${token}`,
                'X-flowdock-wait-for-message': true,
            },
            json: true,
            url: `https://api.flowdock.com/flows/${org}/${body.flow}/messages/`,
        };
        return request.post(requestOpts).then((resData: any) => {
            // Massage the response into a suitable form for the framework
            return {
                response: {
                    message: resData.id,
                    thread: resData.thread_id,
                    url: `https://www.flowdock.com/app/${org}/${body.flow}/threads/${resData.thread_id}`,
                },
                source: this.serviceName,
            };
        });
    }

    /**
     * Search for recent private messages with our account that match on username and regex.
     * @param username  scope of the private messages to search.
     * @param filter    Narrow our search to just matches.
     * @returns         Promise that resolves to the message strings.
     */
    private fetchPrivateMessages(username: string, filter: RegExp): Promise<string[]> {
        // Fetch the id then 1-1 history associated with the username
        return this.fetchUserId(username)
        .then((userId) => {
            return this.fetchFromSession(`/private/${userId}/messages`)
            .then((fetchedMessages) => {
                // Prune and clean the message history to text of interest
                return(_.filter(fetchedMessages, (message: FlowdockMessage) => {
                    return filter.test(message.content);
                }).map((message: FlowdockMessage) => {
                    return message.content;
                }));
            });
        });
    }

    /**
     * Fetch a user's id from their username.
     * @param username  username to search for.
     * @returns         id of the user.
     */
    private fetchUserId(username: string): Promise<string> {
        // Get all the users of the service
        return this.fetchFromSession(`/organizations/${process.env.FLOWDOCK_ORGANIZATION_NAME}/users`)
        .then((foundUsers) => {
            // Generate an array of user objects with matching username
            const matchingUsers = _.filter(foundUsers, (eachUser: any) => {
                return eachUser.nick === username;
            });
            // Return id if we've exactly one user for a particular username
            if (matchingUsers.length === 1) {
                return(matchingUsers[0].id);
            } else {
                throw new Error('Wrong number of users found in flowdock');
            }
        });
    }

    /**
     * Utility function to structure the flowdock session as a promise a little.
     * @param path  Endpoint to retrieve.
     * @returns     response from the session.
     */
    private fetchFromSession(path: string): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            // The flowdock service both emits and calls back the error.
            // We're wrapping the emit in a promise reject and ignoring the call back
            FlowdockService.session.on('error', reject);
            FlowdockService.session.get(path, {}, (_error?: Error, result?: any) => {
                FlowdockService.session.removeListener('error', reject);
                if (result) { resolve(result); }
            });
        });
    }

    /**
     * Get the service name, as required by the framework.
     * @return  The specific service name for Flowdock.
     */
    get serviceName(): string {
        return FlowdockService._serviceName;
    }

    /**
     * Retrieve the SDK API handle for Flowdock.
     * @return  The Flowdock SDK API handle.
     */
    get apiHandle(): FlowdockHandle {
        return {
            flowdock: FlowdockService.session
        };
    }
}

/**
 * Build this class, typed and activated as a listener.
 * @returns  Service Listener object, awakened and ready to go.
 */
export function createServiceListener(): ServiceListener {
    return new FlowdockService(true);
}

/**
 * Build this class, typed as an emitter.
 * @returns  Service Emitter object, ready for your events.
 */
export function createServiceEmitter(): ServiceEmitter {
    return new FlowdockService(false);
}

/**
 * Build this class, typed as a message service.
 * @returns  Message Service object, ready to convert events.
 */
export function createMessageService(): MessageService {
    return new FlowdockService(false);
}

//noinspection JSUnusedGlobalSymbols
/**
 * Build this class, typed as a data hub.
 * @returns Data Hub object, ready to retrieve user data.
 */
export function createDataHub(): DataHub {
    return new FlowdockService(false);
}
