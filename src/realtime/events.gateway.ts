import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';



@WebSocketGateway({ cors: { origin: '*' } })
export class EventsGateway {
  @WebSocketServer() server!: Server;

  @SubscribeMessage('join')
  handleJoin(@MessageBody() data: { room: string }, @ConnectedSocket() client: Socket) {
    if (data?.room) {
      client.join(data.room);
      client.emit('joined', { room: data.room });
    }
  }

  emitLike(event: 'like.created' | 'like.removed', payload: { contentType: string; contentId: string; userId: string; likeCount: number }) {
    const room = `${payload.contentType}:${payload.contentId}`;
    this.server.to(room).emit(event, { ...payload, version: 1, ts: Date.now() });
  }

  // Comment events (rooms may be target rooms or COMMENT:{id} for likes on a comment)
  emitComment(event: 'comment.created' | 'comment.deleted' | 'comment.liked', room: string, payload: any) {
    this.server.to(room).emit(event, { ...payload, version: 1, ts: Date.now() });
  }
}
