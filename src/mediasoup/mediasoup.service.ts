import { Injectable, OnModuleInit } from '@nestjs/common';
import { createWorker } from 'mediasoup';
import { Router, Worker, AppData } from 'mediasoup/node/lib/types';

@Injectable()
export class MediasoupService implements OnModuleInit {
  worker: Worker<AppData>;
  router: Router<AppData>;
  transports = new Map();
  producers = new Map();
  consumers = new Map();
  userTransports = new Map();

  async onModuleInit() {
    this.worker = await createWorker({
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
    });

    this.router = await this.worker.createRouter({
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          parameters: {
            'sprop-stereo': 1,
            'stereo': 1,
            'useinbandfec': 1, // Forward error correction
            'usedtx': 0, // Disable discontinuous transmission
          },
        },
      ],
    });

    console.log('Mediasoup worker + router ready');
  }

  getRtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  async createWebRtcTransport(clientId: string) {
    const transport = await this.router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }], // Use localhost for local testing
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
    });

    this.transports.set(transport.id, transport);

    // keep track of client transports
    if (!this.userTransports.has(clientId)) {
      this.userTransports.set(clientId, {});
    }

    console.log('Transport created with ICE candidates:', transport.iceCandidates);

    return transport;
  }
}
