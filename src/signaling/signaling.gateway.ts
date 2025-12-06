import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { MediasoupService } from '../mediasoup/mediasoup.service';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({ cors: true })
export class SignalingGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private rooms = new Map<string, Set<string>>(); // roomId -> Set of clientIds
  private clientRooms = new Map<string, string>(); // clientId -> roomId
  private clientProducers = new Map<string, string[]>(); // clientId -> producerId[]

  constructor(private readonly ms: MediasoupService) {}

  handleDisconnect(client: Socket) {
    const roomId = this.clientRooms.get(client.id);
    if (roomId) {
      const room = this.rooms.get(roomId);
      if (room) {
        room.delete(client.id);
        // Notify others in room
        client.to(roomId).emit('userLeft', { clientId: client.id });
      }
      this.clientRooms.delete(client.id);
    }
    this.clientProducers.delete(client.id);
  }

  @SubscribeMessage('join')
  async joinRoom(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { roomId } = data;
    console.log(`🚪 [${client.id}] Joining room: ${roomId}`);

    // Leave previous room if any
    const previousRoom = this.clientRooms.get(client.id);
    if (previousRoom) {
      client.leave(previousRoom);
      this.rooms.get(previousRoom)?.delete(client.id);
      console.log(`  ← Left previous room: ${previousRoom}`);
    }

    // Join new room
    client.join(roomId);
    this.clientRooms.set(client.id, roomId);

    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Set());
    }
    this.rooms.get(roomId).add(client.id);

    // Get existing producers in room
    const existingProducers = [];
    for (const otherId of this.rooms.get(roomId)) {
      if (otherId !== client.id) {
        const producers = this.clientProducers.get(otherId) || [];
        existingProducers.push(
          ...producers.map((pid) => {
            const producer = this.ms.producers.get(pid);
            return {
              producerId: pid,
              clientId: otherId,
              kind: producer?.kind || 'audio',
            };
          }),
        );
      }
    }

    console.log(`  ✅ Joined room. Existing producers:`, existingProducers);
    console.log(
      `  📊 Room ${roomId} now has ${this.rooms.get(roomId).size} clients`,
    );

    // Notify others in room
    client.to(roomId).emit('userJoined', { clientId: client.id });

    return { joined: true, existingProducers };
  }

  @SubscribeMessage('getRtpCapabilities')
  getCaps() {
    return this.ms.getRtpCapabilities();
  }

  @SubscribeMessage('createTransport')
  async createTransport(@ConnectedSocket() client: Socket) {
    console.log(`🔌 [${client.id}] Creating WebRTC transport`);
    const transport = await this.ms.createWebRtcTransport(client.id);

    // Monitor transport events
    transport.on('dtlsstatechange', (dtlsState) => {
      console.log(`  🔐 Transport ${transport.id} DTLS state:`, dtlsState);
      if (dtlsState === 'failed' || dtlsState === 'closed') {
        console.error(`  ❌ Transport ${transport.id} DTLS failed`);
      }
    });

    transport.on('icestatechange', (iceState) => {
      console.log(`  🧊 Transport ${transport.id} ICE state:`, iceState);
    });

    console.log(`  ✅ Transport created: ${transport.id}`);
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  @SubscribeMessage('connectTransport')
  async connectTransport(@MessageBody() data) {
    console.log(`🔗 Connecting transport: ${data.transportId}`);
    const transport = this.ms.transports.get(data.transportId);

    if (!transport) {
      console.error(`  ❌ Transport not found: ${data.transportId}`);
      throw new Error('Transport not found');
    }

    console.log(
      `  🔐 Transport ${data.transportId} current DTLS state:`,
      transport.dtlsState,
    );

    await transport.connect({ dtlsParameters: data.dtlsParameters });

    console.log(
      `  ✅ Transport connected. DTLS state:`,
      transport.dtlsState,
      'ICE state:',
      transport.iceState,
    );

    return { connected: true };
  }

  @SubscribeMessage('produce')
  async produce(@MessageBody() data, @ConnectedSocket() client: Socket) {
    console.log(
      `📤 [${client.id}] Producing ${data.kind} on transport: ${data.transportId}`,
    );

    const transport = this.ms.transports.get(data.transportId);
    if (!transport) {
      console.error(`  ❌ Transport not found: ${data.transportId}`);
      throw new Error('Transport not found');
    }

    const producer = await transport.produce({
      kind: data.kind,
      rtpParameters: data.rtpParameters,
    });

    this.ms.producers.set(producer.id, producer);
    console.log(`  ✅ Producer created: ${producer.id}`);

    // Track producer for this client
    if (!this.clientProducers.has(client.id)) {
      this.clientProducers.set(client.id, []);
    }
    this.clientProducers.get(client.id).push(producer.id);

    // Notify others in the room
    const roomId = this.clientRooms.get(client.id);
    if (roomId) {
      const room = this.rooms.get(roomId);
      const otherClients = Array.from(room).filter((id) => id !== client.id);
      console.log(
        `  📢 Notifying ${otherClients.length} other client(s) in room ${roomId}`,
      );

      client.to(roomId).emit('newProducer', {
        producerId: producer.id,
        clientId: client.id,
        kind: producer.kind,
      });
    } else {
      console.log(`  ⚠️ Client not in any room`);
    }

    return { id: producer.id };
  }

  @SubscribeMessage('consume')
  async consume(@MessageBody() data, @ConnectedSocket() client: Socket) {
    console.log(
      `📥 [${client.id}] Consuming producer ${data.producerId} on transport ${data.transportId}`,
    );

    const transport = this.ms.transports.get(data.transportId);
    if (!transport) {
      console.error(`  ❌ Transport not found: ${data.transportId}`);
      throw new Error('Transport not found');
    }

    const producer = this.ms.producers.get(data.producerId);
    if (!producer) {
      console.error(`  ❌ Producer not found: ${data.producerId}`);
      throw new Error('Producer not found');
    }

    // Safety check: Verify client isn't consuming their own producer
    const producerClientId = Array.from(this.clientProducers.entries()).find(
      ([, producers]) => producers.includes(data.producerId),
    )?.[0];

    if (producerClientId === client.id) {
      console.warn(
        `  ⚠️ Client ${client.id} attempting to consume own producer - blocking`,
      );
      throw new Error('Cannot consume own producer');
    }

    console.log(`  📊 Producer details:`, {
      id: producer.id,
      kind: producer.kind,
      paused: producer.paused,
      score: producer.score,
    });

    const consumer = await transport.consume({
      producerId: data.producerId,
      rtpCapabilities: data.rtpCapabilities,
      paused: false, // Start unpaused
    });

    this.ms.consumers.set(consumer.id, consumer);

    console.log(`  📊 Consumer created:`, {
      id: consumer.id,
      kind: consumer.kind,
      paused: consumer.paused,
      producerPaused: consumer.producerPaused,
    });
    console.log(
      `  ✅ Consumer created: ${consumer.id} (kind: ${consumer.kind})`,
    );

    return {
      id: consumer.id,
      producerId: data.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  }

  @SubscribeMessage('resumeConsumer')
  async resumeConsumer(@MessageBody() data) {
    console.log(`▶️ Resuming consumer: ${data.consumerId}`);

    const consumer = this.ms.consumers.get(data.consumerId);
    if (consumer) {
      await consumer.resume();
      console.log(`  ✅ Consumer resumed: ${data.consumerId}`);
    } else {
      console.error(`  ❌ Consumer not found: ${data.consumerId}`);
    }
    return { resumed: true };
  }
}
