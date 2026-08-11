export interface RoutedMessage {
    type: string;
    id?: string;
    payload?: unknown;
}

export type MessageHandler<Client, Message extends RoutedMessage = RoutedMessage> = (
    client: Client,
    message: Message,
) => void | Promise<void>;

/** Small domain router used to move handlers out of the Gateway's legacy switch incrementally. */
export class MessageRouter<Client, Message extends RoutedMessage = RoutedMessage> {
    private readonly handlers = new Map<string, MessageHandler<Client, Message>>();

    register(type: string, handler: MessageHandler<Client, Message>): this {
        if (this.handlers.has(type)) throw new Error(`Message handler already registered: ${type}`);
        this.handlers.set(type, handler);
        return this;
    }

    async dispatch(client: Client, message: Message): Promise<boolean> {
        const handler = this.handlers.get(message.type);
        if (!handler) return false;
        await handler(client, message);
        return true;
    }

    has(type: string): boolean {
        return this.handlers.has(type);
    }
}
