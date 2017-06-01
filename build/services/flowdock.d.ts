import * as Promise from 'bluebird';
import { DataHub, MessengerEmitResponse, MessengerEvent, ReceiptContext, TransmitContext } from '../utils/message-types';
import { FlowdockEmitContext, FlowdockHandle } from './flowdock-types';
import { MessageService } from './message-service';
import { ServiceEmitter, ServiceListener } from './service-types';
export declare class FlowdockService extends MessageService implements ServiceEmitter, ServiceListener, DataHub {
    private static _serviceName;
    private static session;
    makeGeneric(data: MessengerEvent): Promise<ReceiptContext>;
    makeSpecific(data: TransmitContext): Promise<FlowdockEmitContext>;
    translateEventName(eventType: string): string;
    fetchNotes(thread: string, room: string, filter: RegExp): Promise<string[]>;
    fetchValue(user: string, key: string): Promise<string>;
    protected activateMessageListener(): void;
    protected sendPayload(data: FlowdockEmitContext): Promise<MessengerEmitResponse>;
    private fetchPrivateMessages(username, filter);
    private fetchUserId(username);
    private fetchFromSession(path);
    readonly serviceName: string;
    readonly apiHandle: FlowdockHandle;
}
export declare function createServiceListener(): ServiceListener;
export declare function createServiceEmitter(): ServiceEmitter;
export declare function createMessageService(): MessageService;
export declare function createDataHub(): DataHub;
