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
import * as _ from 'lodash';
import * as path from 'path';
import * as request from 'request-promise';
import { MessengerEmitResponse, MessengerEvent, ReceiptContext, TransmitContext } from '../utils/message-types';
import { DiscoursePost, DiscoursePostEmitContext, DiscourseTopicEmitContext } from './discourse-types';
import { MessageService } from './message-service';
import { ServiceEmitter, ServiceListener } from './service-types';

export class DiscourseService extends MessageService implements ServiceListener, ServiceEmitter {
    private static _serviceName = path.basename(__filename.split('.')[0]);
    // There are circumstances in which the discourse web-hook will fire twice for the same post, so track.
    private postsSynced = new Set<number>();

    /**
     * Promise to turn the data enqueued into a generic message format
     * @param data - Raw data from the enqueue, remembering this is as dumb and quick as possible
     * @returns {Bluebird<ReceiptContext>} - A promise that resolves to the generic form of the event
     */
    public makeGeneric(data: MessengerEvent): Promise<ReceiptContext> {
        // Encode once the common parts of a request
        const getGeneric = {
            json: true,
            method: 'GET',
            qs: {
                api_key: process.env.DISCOURSE_LISTENER_ACCOUNT_API_TOKEN,
                api_username: process.env.DISCOURSE_LISTENER_ACCOUNT_USERNAME,
            },
            // appended before execution
            uri: `https://${process.env.DISCOURSE_INSTANCE_URL}`,
        };
        // Gather more complete details of the enqueued event
        const getPost = _.cloneDeep(getGeneric);
        getPost.uri += `/posts/${data.rawEvent.id}`;
        const getTopic = _.cloneDeep(getGeneric);
        getTopic.uri += `/t/${data.rawEvent.topic_id}`;
        return Promise.props({
            post: request(getPost),
            topic: request(getTopic),
        })
        .then((details: {post: any, topic: any}) => {
            // Gather metadata and resolve
            const metadata = MessageService.extractMetadata(details.post.raw);
            const first = details.post.post_number === 1;
            return {
                action: 'create',
                first,
                genesis: metadata.genesis || data.source,
                // post_type 4 seems to correspond to whisper
                hidden: first ? !details.topic.visible : details.post.post_type === 4,
                source: 'discourse',
                sourceIds: {
                    // These come in as integers, but should be strings
                    flow: details.topic.category_id.toString(),
                    message: details.post.id.toString(),
                    thread: details.post.topic_id.toString(),
                    url: getTopic.uri,
                    user: details.post.username,
                },
                text: metadata.content,
                title: details.topic.title,
            } as ReceiptContext;
        });
    }

    /**
     * Promise to turn the generic message format into a specific form to be emitted
     * @param data - Generic message format object to be encoded
     * @returns {Bluebird<FlowdockEmitContext>} - Promise that resolves to the emit suitable form
     */
    public makeSpecific(data: TransmitContext): Promise<DiscourseTopicEmitContext|DiscoursePostEmitContext> {
        // Attempt to find the thread ID to know if this is a new topic or not
        const topicId = data.toIds.thread;
        if (!topicId) {
            const title = data.title;
            if (!title) {
                throw new Error('Cannot create Discourse Thread without a title');
            }
            // A new topic request for discourse
            return Promise.resolve({
                api_token: data.toIds.token,
                api_username: data.toIds.user,
                category: data.toIds.flow,
                raw: data.text + '\n\n---\n' + MessageService.stringifyMetadata(data),
                title,
                type: 'topic',
                unlist_topic: data.hidden ? 'true' : 'false',
            } as DiscourseTopicEmitContext);
        }
        // A new message request for discourse
        return Promise.resolve({
            api_token: data.toIds.token,
            api_username: data.toIds.user,
            raw: data.text + '\n\n---\n' + MessageService.stringifyMetadata(data),
            topic_id: topicId,
            type: 'post',
            whisper: data.hidden ? 'true' : 'false',
        } as DiscoursePostEmitContext);
    }

    /**
     * Turns the generic, messenger, name for an event into a specific trigger name for this class
     * @param eventType - Name of the event to translate, eg 'message'
     * @returns {string} - This class's equivalent, eg 'post'
     */
    public translateEventName(eventType: string): string {
        const equivalents: {[key: string]: string} = {
            message: 'post',
        };
        return equivalents[eventType];
    }

    /**
     * Promise to find the comment history of a particular thread
     * @param thread - id of the thread to search
     * @param _room - id of the room in which the thread resides
     * @param filter - criteria to match
     */
    public fetchNotes(thread: string, _room: string, filter: RegExp): Promise<string[]> {
        // Query the API
        const getThread = {
            json: true,
            method: 'GET',
            qs: {
                api_key: process.env.DISCOURSE_LISTENER_ACCOUNT_API_TOKEN,
                api_username: process.env.DISCOURSE_LISTENER_ACCOUNT_USERNAME,
            },
            uri: `https://${process.env.DISCOURSE_INSTANCE_URL}/t/${thread}`,
        };
        return request(getThread).then((threadObject) => {
            return _.map(threadObject.post_stream.posts, (item: DiscoursePost) => {
                // Clean the response down to only the text
                return item.cooked;
            }).filter((value: string) => {
                // Filter the response down to only matches
                const match = value.match(filter);
                return match !== null && match.length > 0;
            });
        });
    }

    /**
     * Activate this service as a listener
     */
    protected activateMessageListener(): void {
        // Create an endpoint for this listener and protect against double-web-hooks
        MessageService.app.post(`/${this.serviceName}/`, (formData, response) => {
            if(!this.postsSynced.has(formData.body.post.id)) {
                this.postsSynced.add(formData.body.post.id);
                // Enqueue the event as simply as possible
                this.queueEvent({
                    data: {
                        cookedEvent: {
                            context: formData.body.post.topic_id,
                            type: 'post',
                        },
                        rawEvent: formData.body.post,
                        source: this.serviceName,
                    },
                    workerMethod: this.handleEvent,
                });
            }
            // Thank you, bye-bye
            response.send();
        });
    }

    /**
     * Deliver the payload to the service. Sourcing the relevant context has already been performed
     * @param data - The object to be delivered to the service
     * @returns {Promise<MessengerEmitResponse>} - Response from the service endpoint
     */
    protected sendPayload(data: DiscoursePostEmitContext|DiscourseTopicEmitContext): Promise<MessengerEmitResponse> {
        // Extract a couple of details from out of the context
        const body = _.clone(data);
        delete body.api_token;
        delete body.api_username;
        // Build and send a request to the API endpoint
        const requestOptions = {
            body,
            json: true,
            qs: { api_key: data.api_token, api_username: data.api_username },
            url: `https://${process.env.DISCOURSE_INSTANCE_URL}/posts`
        };
        return request.post(requestOptions).then((resData) => {
            // Translate the response from the API back into the message service
            return {
                response: {
                    message: resData.id,
                    thread: resData.topic_id,
                    url: `https://${process.env.DISCOURSE_INSTANCE_URL}/t/${resData.topic_id}`
                },
                source: this.serviceName,
            };
        });
    }

    /**
     * Get the service name, as required by the framework
     * @return  The service name for Discourse.
     */
    get serviceName(): string {
        return DiscourseService._serviceName;
    }

    /**
     * Retrieve Discourse API SDK handle (currently none).
     * @return  void (currently no Discourse SDK API handle)
     */
    get apiHandle(): void {
        return;
    }
}

/**
 * Build this class, typed and activated as a listener
 * @returns {ServiceListener}
 */
export function createServiceListener(): ServiceListener {
    return new DiscourseService(true);
}

/**
 * Build this class, typed as an emitter
 * @returns {ServiceEmitter}
 */
export function createServiceEmitter(): ServiceEmitter {
    return new DiscourseService(false);
}

/**
 * Build this class, typed as a message service
 * @returns {MessageService}
 */
export function createMessageService(): MessageService {
    return new DiscourseService(false);
}
