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
import { Comment, Conversation, Front } from 'front-sdk';
import * as _ from 'lodash';
import * as path from 'path';
import * as request from 'request-promise';
import { MessengerEmitResponse, ReceiptContext, TransmitContext } from '../utils/message-types';
import { FrontCommentEmitContext, FrontConversationEmitContext, FrontHandle } from './front-types';
import { MessageService } from './message-service';
import { ServiceEmitter, ServiceEvent, ServiceListener } from './service-types';

export class FrontService extends MessageService implements ServiceListener, ServiceEmitter {
    private static _serviceName = path.basename(__filename.split('.')[0]);
    private static session = new Front(process.env.FRONT_LISTENER_ACCOUNT_API_TOKEN);

    /**
     * Promise to find the comment history of a particular thread
     * @param thread - id of the thread to search
     * @param _room - id of the room in which the thread resides
     * @param filter - criteria to match
     */
    public fetchNotes(thread: string, _room: string, filter: RegExp): Promise<string[]> {
        return FrontService.session.conversation.listComments({conversation_id: thread})
        .then((comments) => {
            return _.filter(comments._results, (value) => {
                return filter.test(value.body);
            }).map((value) => {
                return value.body;
            });
        });
    }

    /**
     * Promise to turn the data enqueued into a generic message format
     * @param data - Raw data from the enqueue, remembering this is as dumb and quick as possible
     * @returns {Bluebird<ReceiptContext>} - A promise that resolves to the generic form of the event
     */
    public makeGeneric(data: ServiceEvent): Promise<ReceiptContext> {
        // Calculate common request details once
        const getGeneric = {
            headers: {
                authorization: `Bearer ${process.env.FRONT_LISTENER_ACCOUNT_API_TOKEN}`
            },
            json: true,
            method: 'GET',
            uri: '', // Will be over-written
        };
        // Make specific forms of the request object for further details
        const getEvent = _.cloneDeep(getGeneric);
        getEvent.uri = `https://api2.frontapp.com/events/${data.rawEvent.id}`;
        const getInboxes = _.cloneDeep(getGeneric);
        getInboxes.uri = `https://api2.frontapp.com/conversations/${data.rawEvent.conversation.id}/inboxes`;
        const getMessages = _.cloneDeep(getGeneric);
        getMessages.uri = `https://api2.frontapp.com/conversations/${data.rawEvent.conversation.id}/messages`;
        const getComments = _.cloneDeep(getGeneric);
        getComments.uri = `https://api2.frontapp.com/conversations/${data.rawEvent.conversation.id}/comments`;
        // Gather further details of the enqueued event
        return Promise.props({
            comments: request(getComments),
            event: request(getEvent),
            inboxes: request(getInboxes),
            messages: request(getMessages),
        })
        .then((details: {comments: any, event: any, inboxes: any, messages: any}) => {
            // Pre-calculate a couple of values, to save line width
            const message = details.event.target.data;
            const first = details.comments._results.length + details.messages._results.length === 1;
            const metadata = MessageService.extractMetadata(message.text || message.body);
            // Attempt to find the author of a message from the various places front might store it
            let author = 'Unknown';
            if (message.author) {
                author = message.author.username;
            } else {
                for (const recipient of message.recipients) {
                    if (recipient.role === 'from') {
                        author = recipient.handle;
                    }
                }
            }
            // Return the generic form of this event
            return {
                action: 'create',
                first,
                genesis: metadata.genesis || data.source || this.serviceName,
                hidden: first ? metadata.hidden : details.event.type === 'comment',
                source: this.serviceName,
                sourceIds: {
                    flow: details.inboxes._results[0].id,
                    message: message.id,
                    thread: details.event.conversation.id,
                    url: `https://app.frontapp.com/open/${details.event.conversation.id}`,
                    user: author,
                },
                text: metadata.content,
                title: details.event.conversation.subject,
            } as ReceiptContext;
        });
    }

    /**
     * Promise to turn the generic message format into a specific form to be emitted
     * @param data - Generic message format object to be encoded
     * @returns {Bluebird<FlowdockEmitContext>} - Promise that resolves to the emit suitable form
     */
    public makeSpecific(data: TransmitContext): Promise<FrontCommentEmitContext|FrontConversationEmitContext> {
        // Attempt to find the thread ID to know if this is a new conversation or not
        const conversationId = data.toIds.thread;
        if (!conversationId) {
            // Find the title and user ID for the event
            const subject = data.title;
            if (!subject) {
                throw new Error('Cannot create Front Conversation without a title');
            }
            return this.fetchUserId(data.toIds.user).then((userId) => {
                // The specific form that may be emitted
                return {
                    author_id: userId,
                    body: data.text + '\n\n---\n' + MessageService.stringifyMetadata(data, 'plaintext'),
                    // Find the relevant channel for the inbox
                    channel_id: JSON.parse(process.env.FRONT_INBOX_CHANNELS)[data.toIds.flow],
                    metadata: {
                        thread_ref: data.sourceIds.thread,
                    },
                    options: {
                        archive: false,
                    },
                    sender: {
                        handle: data.toIds.user,
                    },
                    subject,
                    to: [data.sourceIds.user],
                    type: 'conversation',
                } as FrontConversationEmitContext;
            });
        }
        return Promise.props({
            conversation: FrontService.session.conversation.get({conversation_id: conversationId}),
            userId: this.fetchUserId(data.toIds.user)
        }).then((details: {conversation: Conversation, userId: string}) => {
            return {
                author_id: details.userId,
                body: data.text + '\n\n---\n' + MessageService.stringifyMetadata(data, 'plaintext'),
                conversation_id: conversationId,
                options: {
                    archive: false,
                },
                sender: {
                    handle: data.toIds.user,
                },
                subject: details.conversation.subject,
                type: data.hidden ? 'comment' : 'message',
            } as FrontCommentEmitContext;
        });
    }

    /**
     * Turns the generic, messenger, name for an event into a specific trigger name for this class
     * @param eventType - Name of the event to translate, eg 'message'
     * @returns {string} - This class's equivalent, eg 'post'
     */
    public translateEventName(eventType: string): string {
        const equivalents: {[key: string]: string} = {
            message: 'event',
        };
        return equivalents[eventType];
    }

    /**
     * Activate this service as a listener
     */
    protected activateMessageListener(): void {
        // This swallows response attempts to the channel, since we notice them on the inbox instead
        MessageService.app.post('/front-dev-null', (_formData, response) => {
            response.send();
        });
        // Create an endpoint for this listener and enqueue events
        MessageService.app.post(`/${this.serviceName}/`, (formData, response) => {
            this.queueEvent({
                data: {
                    cookedEvent: {
                        context: formData.body.conversation.id,
                        type: 'event',
                    },
                    rawEvent: formData.body,
                    source: this.serviceName,
                },
                workerMethod: this.handleEvent,
            });
            response.send();
        });
    }

    /**
     * Deliver the payload to the service. Sourcing the relevant context has already been performed
     * @param data - The object to be delivered to the service
     * @returns {Promise<MessengerEmitResponse>} - Response from the service endpoint
     */
    protected sendPayload(data: FrontCommentEmitContext|FrontConversationEmitContext): Promise<MessengerEmitResponse> {
        if (data.type === 'comment') {
            // The event is sent to the comment method
            return FrontService.session.comment.create(data).then((comment: Comment) => {
                return {
                    response: {
                        message: comment.id,
                        thread: data.conversation_id,
                    },
                    source: this.serviceName,
                };
            });
        } else if (data.type === 'message') {
            // The event is sent to the message (reply) method
            return FrontService.session.message.reply(data).then(() => {
                return {
                    response: {
                        message: `${data.author_id}:${new Date().getTime()}`,
                        thread: data.conversation_id,
                    },
                    source: this.serviceName,
                };
            });
        } else if (data.type === 'conversation') {
            // The event is sent to the message (create) method
            return FrontService.session.message.send(data).then(() => {
                // This is because the response is ASAP and doesn't include the conversation id
                return this.findConversation(data.subject)
                .then((conversationId) => {
                    return {
                        response: {
                            message: `${data.author_id}:${new Date().getTime()}`,
                            thread: conversationId,
                            url: `https://app.frontapp.com/open/${conversationId}`,
                        },
                        source: this.serviceName,
                    };
                });
            });
        }
        throw new Error(`Front payload type ${data.type} not supported`);
    }

    /**
     * Find the ID of a user specified by username
     * @param username - target username to search for
     * @returns {Promise<string>} - Promise that resolves to the user id
     */
    private fetchUserId(username: string): Promise<string> {
        // Request a list of all teammates
        const getTeammates = {
            headers: {
                authorization: `Bearer ${process.env.FRONT_LISTENER_ACCOUNT_API_TOKEN}`
            },
            json: true,
            method: 'GET',
            uri: 'https://api2.frontapp.com/teammates',
        };
        return request(getTeammates).then((teammates: {_results: Array<{username: string, id: string}>}) => {
            // Resolve to the ID of the first matching teammate
            return _.filter(teammates._results, (teammate) => {
                return teammate.username === username;
            }).map((teammate) => {
                return teammate.id;
            })[0];
        });
    }

    /**
     * Attempt to find a recent conversation ID from it's subject line
     * Done by subject because the conversation_reference provided is sometimes junk
     * @param subject - target subject line to search for
     * @param attemptsLeft - Since conversations take time to propagate this method may recurse
     * @returns {Bluebird<string>} - Promise that resolves to the ID of the conversation
     */
    private findConversation(subject: string, attemptsLeft: number = 10): Promise<string> {
        // Find all the recent conversations
        return FrontService.session.conversation.list().then((response) => {
            // Filter these down to matching conversations
            const conversationsMatched = _.filter(response._results, (conversation) => {
                return conversation.subject === subject;
            });
            // Return the most recent, if any
            if (conversationsMatched.length > 0) {
                return conversationsMatched[0].id;
            }
            // Recurse up to the specified number of times
            if (attemptsLeft > 1) {
                return this.findConversation(subject, attemptsLeft - 1);
            } else {
                throw new Error('Could not find relevant conversation.');
            }
        });
    }

    /**
     * The name of this service, as required by the framework
     * @returns {string} - 'flowdock'
     */
    get serviceName(): string {
        return FrontService._serviceName;
    }

    /**
     * Retrieve the SDK API handle for Front.
     * @return  The Front SDK API handle.
     */
    get apiHandle(): FrontHandle {
        return {
            front: FrontService.session
        };
    }
}

/**
 * Build this class, typed and activated as a listener
 * @returns {ServiceListener}
 */
export function createServiceListener(): ServiceListener {
    return new FrontService(true);
}

/**
 * Build this class, typed as an emitter
 * @returns {ServiceEmitter}
 */
export function createServiceEmitter(): ServiceEmitter {
    return new FrontService(false);
}

/**
 * Build this class, typed as a message service
 * @returns {MessageService}
 */
export function createMessageService(): MessageService {
    return new FrontService(false);
}