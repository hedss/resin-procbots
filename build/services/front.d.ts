import * as Promise from 'bluebird';
import { FrontEmitContext, FrontHandle } from './front-types';
import { Messenger } from './messenger';
import { MessengerEmitResponse, ReceiptContext, TransmitContext } from './messenger-types';
import { ServiceEmitter, ServiceEvent, ServiceListener } from './service-types';
export declare class FrontService extends Messenger implements ServiceListener, ServiceEmitter {
    private static _serviceName;
    private static session;
    fetchNotes(thread: string, _room: string, filter: RegExp): Promise<string[]>;
    makeGeneric(data: ServiceEvent): Promise<ReceiptContext>;
    makeSpecific(data: TransmitContext): Promise<FrontEmitContext>;
    translateEventName(eventType: string): string;
    protected activateMessageListener(): void;
    protected sendPayload(data: FrontEmitContext): Promise<MessengerEmitResponse>;
    private fetchUserId(username);
    private findConversation(subject, attemptsLeft?);
    readonly serviceName: string;
    readonly apiHandle: FrontHandle;
}
export declare function createServiceListener(): ServiceListener;
export declare function createServiceEmitter(): ServiceEmitter;
export declare function createMessageService(): Messenger;
