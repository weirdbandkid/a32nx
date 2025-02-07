//  Copyright (c) 2022 FlyByWire Simulations
//  SPDX-License-Identifier: GPL-3.0

import { HoppieConnector } from './com/HoppieConnector';
import { AtsuStatusCodes } from './AtsuStatusCodes';
import { AtsuMessageComStatus, AtsuMessage, AtsuMessageType, AtsuMessageDirection } from './messages/AtsuMessage';
import { CpdlcMessageResponse, CpdlcMessageRequestedResponseType, CpdlcMessage } from './messages/CpdlcMessage';
import { Datalink } from './com/Datalink';
import { AtsuManager } from './AtsuManager';

export class AtcSystem {
    private parent: AtsuManager | undefined = undefined;

    private datalink: Datalink | undefined = undefined;

    private listener = RegisterViewListener('JS_LISTENER_SIMVARS');

    private cdplcResetRequired = false;

    private currentAtc = '';

    private nextAtc = '';

    private notificationTime = 0;

    private cpdlcMessageId = 0;

    private messageQueue: CpdlcMessage[] = [];

    private dcduBufferedMessages: number[] = [];

    private unreadMessagesLastCycle: number = 0;

    private lastRingTime: number = 0;

    constructor(parent: AtsuManager, datalink: Datalink) {
        this.parent = parent;
        this.datalink = datalink;

        // initialize the variables for the DCDU communication
        SimVar.SetSimVarValue('L:A32NX_DCDU_MSG_DELETE_UID', 'number', -1);
        SimVar.SetSimVarValue('L:A32NX_DCDU_MSG_ANSWER', 'number', -1);
        SimVar.SetSimVarValue('L:A32NX_DCDU_MSG_SEND_UID', 'number', -1);
        SimVar.SetSimVarValue('L:A32NX_DCDU_MSG_PRINT_UID', 'number', -1);

        setInterval(() => {
            const cpdlcOnline = SimVar.GetSimVarValue('L:A32NX_HOPPIE_ACTIVE', 'number') === 1;

            if (this.cdplcResetRequired && !cpdlcOnline) {
                if (this.currentAtc !== '') {
                    this.logoff();
                }
                if (this.nextAtc !== '') {
                    this.resetLogon();
                }

                this.listener.triggerToAllSubscribers('A32NX_DCDU_RESET');
                this.cdplcResetRequired = false;
            } else if (cpdlcOnline) {
                this.cdplcResetRequired = true;

                this.handleDcduMessageSync();
                this.handlePilotNotifications();

                // check if we have to timeout the logon request
                if (this.logonInProgress()) {
                    const currentTime = SimVar.GetGlobalVarValue('ZULU TIME', 'seconds');
                    const delta = currentTime - this.notificationTime;
                    if (delta >= 300) {
                        this.resetLogon();
                    }
                }
            }
        }, 100);
    }

    private handleDcduMessageSync() {
        if (SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_DELETE_UID', 'number') !== -1) {
            this.removeMessage(SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_DELETE_UID', 'number'));
            SimVar.SetSimVarValue('L:A32NX_DCDU_MSG_DELETE_UID', 'number', -1);
        }
        if (SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_SEND_UID', 'number') !== -1 && SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_ANSWER', 'number') !== -1) {
            this.sendResponse(SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_SEND_UID', 'number'), SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_ANSWER', 'number') as CpdlcMessageResponse);
            SimVar.SetSimVarValue('L:A32NX_DCDU_MSG_ANSWER', 'number', -1);
            SimVar.SetSimVarValue('L:A32NX_DCDU_MSG_SEND_UID', 'number', -1);
        }
        if (SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_PRINT_UID', 'number') !== -1) {
            const message = this.parent.findMessage(SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_PRINT_UID', 'number'));
            if (message !== undefined) {
                this.parent.printMessage(message);
            }
            SimVar.SetSimVarValue('L:A32NX_DCDU_MSG_PRINT_UID', 'number', -1);
        }

        if (SimVar.GetSimVarValue('L:A32NX_DCDU_ATC_MSG_ACK', 'number') === 1) {
            SimVar.SetSimVarValue('L:A32NX_DCDU_ATC_MSG_WAITING', 'boolean', 0);
            SimVar.SetSimVarValue('L:A32NX_DCDU_ATC_MSG_ACK', 'number', 0);
        }

        // check if the buffer of the DCDU is available
        if (SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_MAX_REACHED', 'boolean') === 0) {
            while (this.dcduBufferedMessages.length !== 0) {
                if (SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_MAX_REACHED', 'boolean') !== 0) {
                    break;
                }

                const uid = this.dcduBufferedMessages.shift();
                const message = this.messageQueue.find((element) => element.UniqueMessageID === uid);
                if (message !== undefined) {
                    this.listener.triggerToAllSubscribers('A32NX_DCDU_MSG', message);
                }
            }
        }
    }

    private handlePilotNotifications() {
        const unreadMessages = SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_UNREAD_MSGS', 'number');

        if (unreadMessages !== 0) {
            const currentTime = new Date().getTime();
            let callRing = false;

            if (this.unreadMessagesLastCycle < unreadMessages) {
                this.lastRingTime = 0;
                callRing = true;
            } else {
                const delta = Math.round(Math.abs((currentTime - this.lastRingTime) / 1000));

                if (delta >= 10) {
                    this.lastRingTime = currentTime;
                    callRing = SimVar.GetSimVarValue('L:A32NX_DCDU_ATC_MSG_WAITING', 'boolean') === 1;
                }
            }

            if (callRing) {
                SimVar.SetSimVarValue('L:A32NX_DCDU_ATC_MSG_WAITING', 'boolean', 1);
                Coherent.call('PLAY_INSTRUMENT_SOUND', 'cpdlc_ring');
                this.lastRingTime = currentTime;

                // ensure that the timeout is longer than the sound
                setTimeout(() => SimVar.SetSimVarValue('W:cpdlc_ring', 'boolean', 0), 2000);
            }
        } else {
            SimVar.SetSimVarValue('L:A32NX_DCDU_ATC_MSG_WAITING', 'boolean', 0);
        }

        this.unreadMessagesLastCycle = unreadMessages;
    }

    public async connect(flightNo: string): Promise<AtsuStatusCodes> {
        if (this.currentAtc !== '') {
            return this.logoff().then(() => HoppieConnector.connect(flightNo));
        }
        return HoppieConnector.connect(flightNo);
    }

    public async disconnect(): Promise<AtsuStatusCodes> {
        return HoppieConnector.disconnect();
    }

    public currentStation(): string {
        return this.currentAtc;
    }

    public nextStation(): string {
        return this.nextAtc;
    }

    public nextStationNotificationTime(): number {
        return this.notificationTime;
    }

    public logonInProgress(): boolean {
        return this.nextAtc !== '';
    }

    public resetLogon(): void {
        this.currentAtc = '';
        this.nextAtc = '';
        this.notificationTime = 0;
        this.listener.triggerToAllSubscribers('A32NX_DCDU_ATC_LOGON_MSG', '');
    }

    public async logon(station: string): Promise<AtsuStatusCodes> {
        if (this.nextAtc !== '' && station !== this.nextAtc) {
            return AtsuStatusCodes.SystemBusy;
        }

        if (this.currentAtc !== '') {
            const retval = await this.logoff();
            if (retval !== AtsuStatusCodes.Ok) {
                return retval;
            }
        }

        const message = new CpdlcMessage();
        message.Station = station;
        message.CurrentTransmissionId = ++this.cpdlcMessageId;
        message.Direction = AtsuMessageDirection.Output;
        message.RequestedResponses = CpdlcMessageRequestedResponseType.Yes;
        message.ComStatus = AtsuMessageComStatus.Sending;
        message.Message = 'REQUEST LOGON';

        this.nextAtc = station;
        this.parent.registerMessage(message);
        this.listener.triggerToAllSubscribers('A32NX_DCDU_ATC_LOGON_MSG', `NEXT ATC: ${station}`);
        this.notificationTime = SimVar.GetGlobalVarValue('ZULU TIME', 'seconds');

        return this.datalink.sendMessage(message, false);
    }

    private async logoffWithoutReset(): Promise<AtsuStatusCodes> {
        if (this.currentAtc === '') {
            return AtsuStatusCodes.NoAtc;
        }

        const message = new CpdlcMessage();
        message.Station = this.currentAtc;
        message.CurrentTransmissionId = ++this.cpdlcMessageId;
        message.Direction = AtsuMessageDirection.Output;
        message.RequestedResponses = CpdlcMessageRequestedResponseType.No;
        message.ComStatus = AtsuMessageComStatus.Sending;
        message.Message = 'LOGOFF';

        this.parent.registerMessage(message);

        return this.datalink.sendMessage(message, true).then((error) => error);
    }

    public async logoff(): Promise<AtsuStatusCodes> {
        return this.logoffWithoutReset().then((error) => {
            this.listener.triggerToAllSubscribers('A32NX_DCDU_ATC_LOGON_MSG', '');
            this.currentAtc = '';
            this.nextAtc = '';
            return error;
        });
    }

    private createCpdlcResponse(request: CpdlcMessage) {
        // create the meta information of the response
        const response = new CpdlcMessage();
        response.Direction = AtsuMessageDirection.Output;
        response.CurrentTransmissionId = ++this.cpdlcMessageId;
        response.PreviousTransmissionId = request.CurrentTransmissionId;
        response.RequestedResponses = CpdlcMessageRequestedResponseType.No;
        response.Station = request.Station;

        // create the answer text
        switch (request.ResponseType) {
        case CpdlcMessageResponse.Acknowledge:
            response.Message = 'ACKNOWLEDGE';
            break;
        case CpdlcMessageResponse.Affirm:
            response.Message = 'AFFIRM';
            break;
        case CpdlcMessageResponse.Negative:
            response.Message = 'NEGATIVE';
            break;
        case CpdlcMessageResponse.Refuse:
            response.Message = 'REFUSE';
            break;
        case CpdlcMessageResponse.Roger:
            response.Message = 'ROGER';
            break;
        case CpdlcMessageResponse.Standby:
            response.Message = 'STANDBY';
            break;
        case CpdlcMessageResponse.Unable:
            response.Message = 'UNABLE';
            break;
        case CpdlcMessageResponse.Wilco:
            response.Message = 'WILCO';
            break;
        default:
            return undefined;
        }

        return response;
    }

    private sendResponse(uid: number, response: CpdlcMessageResponse): void {
        const message = this.messageQueue.find((element) => element.UniqueMessageID === uid);
        if (message !== undefined) {
            message.ResponseType = response;
            message.Response = this.createCpdlcResponse(message);
            message.Response.ComStatus = AtsuMessageComStatus.Sending;
            this.listener.triggerToAllSubscribers('A32NX_DCDU_MSG', message);

            if (message.Response !== undefined) {
                this.datalink.sendMessage(message.Response, false).then((code) => {
                    if (code === AtsuStatusCodes.Ok) {
                        message.Response.ComStatus = AtsuMessageComStatus.Sent;
                    } else {
                        message.Response.ComStatus = AtsuMessageComStatus.Failed;
                    }
                    this.listener.triggerToAllSubscribers('A32NX_DCDU_MSG', message);
                });
            }
        }
    }

    public messages(): AtsuMessage[] {
        return this.messageQueue;
    }

    public static isRelevantMessage(message: AtsuMessage): boolean {
        return message.Type > AtsuMessageType.AOC && message.Type < AtsuMessageType.ATC;
    }

    public removeMessage(uid: number): boolean {
        const index = this.messageQueue.findIndex((element) => element.UniqueMessageID === uid);
        if (index !== -1) {
            this.listener.triggerToAllSubscribers('A32NX_DCDU_MSG_DELETE_UID', uid);
            this.messageQueue.splice(index, 1);
        }
        return index !== -1;
    }

    public cleanupMessages(): void {
        this.messageQueue.forEach((message) => this.listener.triggerToAllSubscribers('A32NX_DCDU_MSG_DELETE_UID', message.UniqueMessageID));
        this.messageQueue = [];
    }

    private analyzeMessage(request: CpdlcMessage, response: CpdlcMessage): boolean {
        // inserted a sent message for a new thread
        if (request.Direction === AtsuMessageDirection.Output && response === undefined) {
            return true;
        }

        if (request.RequestedResponses === CpdlcMessageRequestedResponseType.NotRequired && response === undefined) {
            // received the station message for the DCDU
            if (request.Message.includes('CURRENT ATC')) {
                this.listener.triggerToAllSubscribers('A32NX_DCDU_ATC_LOGON_MSG', request.Message);
                return true;
            }

            // received a logoff message
            if (request.Message.includes('LOGOFF')) {
                this.listener.triggerToAllSubscribers('A32NX_DCDU_ATC_LOGON_MSG', '');
                this.currentAtc = '';
                return true;
            }

            // received a service terminated message
            if (request.Message.includes('TERMINATED')) {
                this.listener.triggerToAllSubscribers('A32NX_DCDU_ATC_LOGON_MSG', '');
                this.currentAtc = '';
                return true;
            }

            // process the handover message
            if (request.Message.includes('HANDOVER')) {
                const entries = request.Message.split(' ');
                if (entries.length >= 2) {
                    const station = entries[1].replace(/@/gi, '');
                    this.logon(station);
                    return true;
                }
            }
        }

        // expecting a LOGON or denied message
        if (this.nextAtc !== '' && request !== undefined && response !== undefined) {
            if (request.Message.startsWith('REQUEST')) {
                // logon accepted by ATC
                if (response.Message.includes('LOGON ACCEPTED')) {
                    this.listener.triggerToAllSubscribers('A32NX_DCDU_ATC_LOGON_MSG', `CURRENT ATC UNIT @${this.nextAtc}@`);
                    this.currentAtc = this.nextAtc;
                    this.nextAtc = '';
                    return true;
                }

                // logon rejected
                if (response.Message.includes('UNABLE')) {
                    this.listener.triggerToAllSubscribers('A32NX_DCDU_ATC_LOGON_MSG', '');
                    this.currentAtc = '';
                    this.nextAtc = '';
                    return true;
                }
            }
        }

        // TODO later analyze requests by ATC
        return false;
    }

    public insertMessage(message: AtsuMessage): void {
        const cpdlcMessage = message as CpdlcMessage;
        let analyzed = false;

        // search corresponding request, if previous ID is set
        if (cpdlcMessage.PreviousTransmissionId !== -1) {
            this.messageQueue.forEach((element) => {
                // ensure that the sending and receiving stations are the same to avoid CPDLC ID overlaps
                if (element.Station === cpdlcMessage.Station) {
                    while (element !== undefined) {
                        if (element.CurrentTransmissionId === cpdlcMessage.PreviousTransmissionId) {
                            if (element.ResponseType === undefined) {
                                element.ResponseType = CpdlcMessageResponse.Other;
                            }
                            element.Response = cpdlcMessage;
                            analyzed = this.analyzeMessage(element, cpdlcMessage);
                            break;
                        }
                        element = element.Response;
                    }
                }
            });
        } else {
            this.messageQueue.unshift(cpdlcMessage);
            analyzed = this.analyzeMessage(cpdlcMessage, undefined);
        }

        if (!analyzed) {
            const dcduRelevant = cpdlcMessage.ComStatus === AtsuMessageComStatus.Open || cpdlcMessage.ComStatus === AtsuMessageComStatus.Received;
            if (dcduRelevant && SimVar.GetSimVarValue('L:A32NX_DCDU_MSG_MAX_REACHED', 'boolean') === 0) {
                this.listener.triggerToAllSubscribers('A32NX_DCDU_MSG', message as CpdlcMessage);
            } else if (dcduRelevant) {
                this.dcduBufferedMessages.push(message.UniqueMessageID);
            }
        }
    }

    public messageRead(uid: number): boolean {
        const index = this.messageQueue.findIndex((element) => element.UniqueMessageID === uid);
        if (index !== -1 && this.messageQueue[index].Direction === AtsuMessageDirection.Input) {
            this.messageQueue[index].Confirmed = true;
        }

        return index !== -1;
    }

    public async sendMessage(message: AtsuMessage): Promise<AtsuStatusCodes> {
        if (message.Station === '') {
            if (this.currentAtc === '') {
                return AtsuStatusCodes.NoAtc;
            }
            message.Station = this.currentAtc;
        }

        message.ComStatus = AtsuMessageComStatus.Sending;
        return this.datalink.sendMessage(message, false).then((retval) => {
            if (retval === AtsuStatusCodes.Ok) {
                message.ComStatus = AtsuMessageComStatus.Sent;
            } else {
                message.ComStatus = AtsuMessageComStatus.Failed;
            }
            return retval;
        });
    }
}
