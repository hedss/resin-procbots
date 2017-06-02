"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Promise = require("bluebird");
const _ = require("lodash");
const path = require("path");
const request = require("request-promise");
const messenger_1 = require("./messenger");
const messenger_types_1 = require("./messenger-types");
class DiscourseService extends messenger_1.Messenger {
    constructor() {
        super(...arguments);
        this.postsSynced = new Set();
    }
    makeGeneric(data) {
        const getGeneric = {
            json: true,
            method: 'GET',
            qs: {
                api_key: process.env.DISCOURSE_LISTENER_ACCOUNT_API_TOKEN,
                api_username: process.env.DISCOURSE_LISTENER_ACCOUNT_USERNAME,
            },
            uri: `https://${process.env.DISCOURSE_INSTANCE_URL}`,
        };
        const getPost = _.cloneDeep(getGeneric);
        getPost.uri += `/posts/${data.rawEvent.id}`;
        const getTopic = _.cloneDeep(getGeneric);
        getTopic.uri += `/t/${data.rawEvent.topic_id}`;
        return Promise.props({
            post: request(getPost),
            topic: request(getTopic),
        })
            .then((details) => {
            const metadata = messenger_1.Messenger.extractMetadata(details.post.raw);
            const first = details.post.post_number === 1;
            return {
                action: messenger_types_1.MessengerAction.Create,
                first,
                genesis: metadata.genesis || data.source,
                hidden: first ? !details.topic.visible : details.post.post_type === 4,
                source: DiscourseService._serviceName,
                sourceIds: {
                    flow: details.topic.category_id.toString(),
                    message: details.post.id.toString(),
                    thread: details.post.topic_id.toString(),
                    url: getTopic.uri,
                    user: details.post.username,
                },
                text: metadata.content,
                title: details.topic.title,
            };
        });
    }
    makeSpecific(data) {
        const topicId = data.toIds.thread;
        if (!topicId) {
            const title = data.title;
            if (!title) {
                throw new Error('Cannot create Discourse Thread without a title');
            }
            return new Promise((resolve) => {
                resolve({
                    endpoint: {
                        api_key: data.toIds.token,
                        api_username: data.toIds.user,
                    },
                    payload: {
                        category: data.toIds.flow,
                        raw: `${data.text}\n\n---\n${messenger_1.Messenger.stringifyMetadata(data)}`,
                        title,
                        unlist_topic: data.hidden ? 'true' : 'false',
                    }
                });
            });
        }
        return new Promise((resolve) => {
            resolve({
                endpoint: {
                    api_key: data.toIds.token,
                    api_username: data.toIds.user,
                },
                payload: {
                    raw: `${data.text}\n\n---\n${messenger_1.Messenger.stringifyMetadata(data)}`,
                    topic_id: topicId,
                    whisper: data.hidden ? 'true' : 'false',
                },
            });
        });
    }
    translateEventName(eventType) {
        const equivalents = {
            message: 'post',
        };
        return equivalents[eventType];
    }
    fetchNotes(thread, _room, filter) {
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
            return _.map(threadObject.post_stream.posts, (item) => {
                return item.cooked;
            }).filter((value) => {
                const match = value.match(filter);
                return match !== null && match.length > 0;
            });
        });
    }
    activateMessageListener() {
        messenger_1.Messenger.app.post(`/${DiscourseService._serviceName}/`, (formData, response) => {
            if (!this.postsSynced.has(formData.body.post.id)) {
                this.postsSynced.add(formData.body.post.id);
                this.queueEvent({
                    data: {
                        cookedEvent: {
                            context: formData.body.post.topic_id,
                            type: 'post',
                        },
                        rawEvent: formData.body.post,
                        source: DiscourseService._serviceName,
                    },
                    workerMethod: this.handleEvent,
                });
            }
            response.send(200);
        });
    }
    sendPayload(data) {
        const requestOptions = {
            body: data.payload,
            json: true,
            qs: data.endpoint,
            url: `https://${process.env.DISCOURSE_INSTANCE_URL}/posts`
        };
        return request.post(requestOptions).then((resData) => {
            return {
                response: {
                    message: resData.id,
                    thread: resData.topic_id,
                    url: `https://${process.env.DISCOURSE_INSTANCE_URL}/t/${resData.topic_id}`
                },
                source: DiscourseService._serviceName,
            };
        });
    }
    get serviceName() {
        return DiscourseService._serviceName;
    }
    get apiHandle() {
        return;
    }
}
DiscourseService._serviceName = path.basename(__filename.split('.')[0]);
exports.DiscourseService = DiscourseService;
function createServiceListener() {
    return new DiscourseService(true);
}
exports.createServiceListener = createServiceListener;
function createServiceEmitter() {
    return new DiscourseService(false);
}
exports.createServiceEmitter = createServiceEmitter;
function createMessageService() {
    return new DiscourseService(false);
}
exports.createMessageService = createMessageService;

//# sourceMappingURL=discourse.js.map
