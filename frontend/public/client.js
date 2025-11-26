import * as mediasoupClient from 'mediasoup-client';

const socket = io('http://localhost:3000');

// Helper function to promisify socket.emit with acknowledgment
function socketRequest(event, data = {}) {
  return new Promise((resolve, reject) => {
    socket.emit(event, data, (response) => {
      if (response && response.error) {
        reject(response.error);
      } else {
        resolve(response);
      }
    });
  });
}

let device;
let sendTransport;
let recvTransport;
let producer;
let audioStream;
let consumers = new Map(); // consumerId -> consumer
let participants = new Map(); // clientId -> participant info
let currentRoomId = null;
let selectedMicrophoneId = null; // Selected microphone device ID
let isMuted = false;
let myClientId = null;

// UI Elements
const joinBtn = document.getElementById('joinBtn');
const muteBtn = document.getElementById('muteBtn');
const leaveBtn = document.getElementById('leaveBtn');
const channelInput = document.getElementById('channelInput');
const microphoneSelect = document.getElementById('microphoneSelect');
const statusDiv = document.getElementById('status');
const joinSection = document.getElementById('joinSection');
const controlsSection = document.getElementById('controls');
const participantList = document.getElementById('participantList');

// Event Listeners
joinBtn.onclick = joinChannel;
muteBtn.onclick = toggleMute;
leaveBtn.onclick = leaveChannel;
channelInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinChannel();
});

// Load available microphones on page load
async function loadMicrophones() {
  try {
    // Request permission first to get device labels
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      stream.getTracks().forEach(track => track.stop());
    });
    
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(device => device.kind === 'audioinput');
    
    console.log('🎤 Available microphones:', audioInputs);
    
    microphoneSelect.innerHTML = '';
    
    if (audioInputs.length === 0) {
      microphoneSelect.innerHTML = '<option value="">No microphones found</option>';
      return;
    }
    
    audioInputs.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Microphone ${index + 1}`;
      microphoneSelect.appendChild(option);
    });
    
    // Set the first microphone as default
    selectedMicrophoneId = audioInputs[0].deviceId;
    
    console.log('✅ Microphones loaded. Default:', audioInputs[0].label);
  } catch (error) {
    console.error('❌ Failed to load microphones:', error);
    microphoneSelect.innerHTML = '<option value="">Error loading microphones</option>';
  }
}

// Update selected microphone when user changes selection
microphoneSelect.onchange = () => {
  selectedMicrophoneId = microphoneSelect.value;
  console.log('🎤 Microphone changed to:', microphoneSelect.options[microphoneSelect.selectedIndex].text);
};

// Load microphones on page load
loadMicrophones();

// Global audio enabler - ensures all audio elements can play
let audioEnabled = false;
document.addEventListener(
  'click',
  () => {
    if (!audioEnabled) {
      audioEnabled = true;
      console.log('🔊 User interaction detected - audio enabled');

      // Try to resume all audio elements
      for (const [clientId, participant] of participants.entries()) {
        if (participant.audio && participant.audio.paused) {
          participant.audio.play().catch((e) => {
            console.log('Could not resume audio for', clientId, ':', e.message);
          });
        }
      }
    }
  },
  { once: true },
);

// Socket Events
socket.on('connect', () => {
  myClientId = socket.id;
  console.log('✅ Connected to server:', myClientId);
});

socket.on('newProducer', async ({ producerId, clientId }) => {
  console.log('📢 NEW PRODUCER EVENT:', { producerId, clientId });
  await consumeAudio(producerId, clientId);
});

socket.on('userJoined', ({ clientId }) => {
  console.log('👤 User joined:', clientId);
  addParticipant(clientId);
});

socket.on('userLeft', ({ clientId }) => {
  console.log('👋 User left:', clientId);
  removeParticipant(clientId);
});

socket.on('disconnect', () => {
  console.log('❌ Disconnected from server');
});

// Main Functions
async function joinChannel() {
  const roomId = channelInput.value.trim();
  if (!roomId) {
    showStatus('Please enter a channel name', 'disconnected');
    return;
  }

  try {
    showStatus('Connecting to channel...', 'connecting');
    joinBtn.disabled = true;

    console.log('🚀 Starting connection process...');
    console.log('📦 mediasoup-client:', mediasoupClient);

    // Initialize mediasoup device
    console.log('📡 Requesting RTP capabilities...');
    const rtpCapabilities = await socketRequest('getRtpCapabilities');
    console.log('✅ Got RTP capabilities:', rtpCapabilities);

    device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    console.log('✅ Device loaded');

    // Create transports
    console.log('🔌 Creating send transport...');
    await createSendTransport();
    console.log('✅ Send transport created');

    console.log('🔌 Creating receive transport...');
    await createRecvTransport();
    console.log('✅ Receive transport created');

    // Get microphone access and start producing
    console.log('🎤 Publishing microphone...');
    await publishMic();
    console.log('✅ Microphone published');

    // Join room
    console.log('🚪 Joining room:', roomId);
    const { existingProducers } = await socketRequest('join', { roomId });
    console.log('✅ Joined room. Existing producers:', existingProducers);
    currentRoomId = roomId;

    // Add myself to participants
    addParticipant(myClientId, true);

    // Consume existing producers
    if (existingProducers && existingProducers.length > 0) {
      console.log(
        '🔊 Consuming',
        existingProducers.length,
        'existing producer(s)...',
      );
      for (const { producerId, clientId } of existingProducers) {
        console.log(
          '  → Consuming producer:',
          producerId,
          'from client:',
          clientId,
        );
        await consumeAudio(producerId, clientId);
        addParticipant(clientId);
      }
    } else {
      console.log('ℹ️ No existing producers to consume');
    }

    showStatus(`Connected to channel: ${roomId}`, 'connected');
    joinSection.style.display = 'none';
    controlsSection.classList.add('show');
    console.log('✅ Connection complete!');
  } catch (error) {
    console.error('Failed to join channel:', error);
    showStatus('Failed to connect to channel', 'disconnected');
    joinBtn.disabled = false;
  }
}

async function createSendTransport() {
  console.log('  📤 Requesting transport params...');
  const params = await socketRequest('createTransport');
  console.log('  📤 Send transport params:', params);

  sendTransport = device.createSendTransport(params);
  console.log('  📤 Send transport created:', sendTransport.id);
  console.log('  📤 Send transport object:', sendTransport);
  console.log('  📤 Send transport properties:', {
    connectionState: sendTransport.connectionState,
    iceConnectionState: sendTransport.iceConnectionState,
    iceGatheringState: sendTransport.iceGatheringState,
    dtlsState: sendTransport.dtlsState,
  });

  // Monitor connection state changes
  sendTransport.on('connectionstatechange', (state) => {
    console.log('  📤 SEND Transport connection state changed:', state);
  });

  sendTransport.on('icestatechange', (state) => {
    console.log('  📤 SEND Transport ICE state changed:', state);
  });

  sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    try {
      console.log('  📤 SEND: Connecting transport...', {
        transportId: sendTransport.id,
      });
      await socketRequest('connectTransport', {
        transportId: sendTransport.id,
        dtlsParameters,
      });
      console.log('  ✅ SEND: Transport connected');
      callback();
    } catch (error) {
      console.error('  ❌ SEND: Transport connect error:', error);
      errback(error);
    }
  });

  sendTransport.on(
    'produce',
    async ({ kind, rtpParameters }, callback, errback) => {
      try {
        console.log('  📤 SEND: Producing...', {
          transportId: sendTransport.id,
          kind,
        });
        const { id } = await socketRequest('produce', {
          transportId: sendTransport.id,
          kind,
          rtpParameters,
        });
        console.log('  ✅ SEND: Producer created:', id);
        callback({ id });
      } catch (error) {
        console.error('  ❌ SEND: Produce error:', error);
        errback(error);
      }
    },
  );
}

async function createRecvTransport() {
  console.log('  📥 Requesting transport params...');
  const params = await socketRequest('createTransport');
  console.log('  📥 Receive transport params:', params);

  recvTransport = device.createRecvTransport(params);
  console.log('  📥 Receive transport created:', recvTransport.id);
  console.log(
    '  📥 Receive transport connection state:',
    recvTransport.connectionState,
  );
  console.log('  📥 Receive transport ice state:', recvTransport.iceState);

  // Monitor connection state changes
  recvTransport.on('connectionstatechange', (state) => {
    console.log('  📥 RECV Transport connection state changed:', state);
  });

  recvTransport.on('icestatechange', (state) => {
    console.log('  📥 RECV Transport ICE state changed:', state);
  });

  recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    try {
      console.log('  📥 RECV: Connecting transport...', {
        transportId: recvTransport.id,
      });
      await socketRequest('connectTransport', {
        transportId: recvTransport.id,
        dtlsParameters,
      });
      console.log('  ✅ RECV: Transport connected');
      callback();
    } catch (error) {
      console.error('  ❌ RECV: Transport connect error:', error);
      errback(error);
    }
  });
}

async function publishMic() {
  try {
    console.log('  🎤 Requesting microphone access...');
    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    
    // Use selected microphone if one is chosen
    if (selectedMicrophoneId) {
      audioConstraints.deviceId = { exact: selectedMicrophoneId };
      console.log('  🎤 Using selected microphone:', selectedMicrophoneId);
    }
    
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });
    console.log('  ✅ Got microphone stream');

    const track = audioStream.getAudioTracks()[0];
    console.log('  🎤 Audio track:', {
      id: track.id,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
    });

    producer = await sendTransport.produce({ 
      track,
      codecOptions: {
        opusStereo: true,
        opusFec: true, // Forward error correction
        opusDtx: false, // Disable discontinuous transmission 
        opusMaxPlaybackRate: 48000,
        opusMaxAverageBitrate: 510000, // Maximum bitrate for Opus
        opusPtime: 20,
      }
    });
    console.log('  ✅ Producer created:', producer.id);
    console.log('  📤 Producer paused:', producer.paused);
    console.log('  📤 Producer track:', producer.track);
    console.log('  📤 Producer codec options: high quality Opus');

    // Make sure producer is not paused
    if (producer.paused) {
      console.log('  ⚠️ Producer is paused, resuming...');
      await producer.resume();
      console.log('  ✅ Producer resumed');
    } else {
      console.log('  ✅ Producer is already active (not paused)');
    }

    producer.on('trackended', () => {
      console.log('  ⚠️ Producer track ended');
    });

    producer.on('transportclose', () => {
      console.log('  ⚠️ Producer transport closed');
    });

    // Monitor outgoing audio levels
    try {
      const audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(audioStream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let lastLog = 0;

      const checkOutputLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;

        const now = Date.now();
        if (average > 0 && now - lastLog > 2000) {
          console.log(
            '  📤 SENDING Audio level:',
            '█'.repeat(Math.floor(average / 5)),
            Math.round(average),
          );
          lastLog = now;
        }
      };

      setInterval(checkOutputLevel, 100);
      console.log('  ✅ Outgoing audio monitoring enabled');
    } catch (e) {
      console.warn('  ⚠️ Could not monitor outgoing audio:', e);
    }

    // Log producer and transport stats periodically
    setInterval(async () => {
      try {
        const stats = await producer.getStats();
        let foundRTP = false;
        stats.forEach((report) => {
          if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            console.log('  📤 SEND Stats:', {
              packetsSent: report.packetsSent,
              bytesSent: report.bytesSent,
            });
            foundRTP = true;
          }

          // Log ALL report types to see what's available
          if (!foundRTP) {
            console.log('  📊 Report type:', report.type, report);
          }
        });
      } catch (e) {
        console.error('  ❌ Error getting stats:', e);
      }
    }, 5000);
  } catch (error) {
    console.error('  ❌ Failed to get microphone access:', error);
    throw error;
  }
}

async function consumeAudio(producerId, clientId) {
  // Safety check: Never consume your own audio (prevent echo)
  if (clientId === myClientId) {
    console.log('  ⚠️ SKIP: Not consuming own producer (clientId:', clientId, '=== myClientId:', myClientId, ')');
    return;
  }

  try {
    console.log(
      '  🔊 CONSUME: Consuming audio from OTHER user:',
      clientId,
      '(Producer:',
      producerId,
      ')',
    );
    console.log('  🔊 CONSUME: Using transport:', recvTransport.id);

    const consumeParams = {
      transportId: recvTransport.id,
      producerId,
      rtpCapabilities: device.rtpCapabilities,
    };
    console.log('  🔊 CONSUME: Params:', consumeParams);

    const { id, kind, rtpParameters } = await socketRequest(
      'consume',
      consumeParams,
    );
    console.log('  ✅ CONSUME: Got consumer params:', { id, kind, producerId });

    const consumer = await recvTransport.consume({
      id,
      producerId,
      kind,
      rtpParameters,
    });
    console.log('  ✅ CONSUME: Consumer created:', consumer.id);
    console.log('  🔊 CONSUME: Consumer track:', {
      id: consumer.track.id,
      kind: consumer.track.kind,
      enabled: consumer.track.enabled,
      muted: consumer.track.muted,
      readyState: consumer.track.readyState,
    });

    consumers.set(id, consumer);
    
    console.log('  📊 Consumer details:', {
      id: consumer.id,
      kind: consumer.kind,
      paused: consumer.paused,
      producerPaused: consumer.producerPaused,
      track: consumer.track,
    });

    // Resume consumer
    console.log('  ▶️ CONSUME: Resuming consumer...');
    await socketRequest('resumeConsumer', { consumerId: id });
    console.log('  ✅ CONSUME: Consumer resumed');
    console.log('  📊 After resume - paused:', consumer.paused, 'producerPaused:', consumer.producerPaused);

    // Create audio element and play
    console.log('  🔊 CONSUME: Creating audio element...');
    const stream = new MediaStream([consumer.track]);
    
    // Create and configure audio element
    const audio = document.createElement('audio');
    audio.srcObject = stream;
    audio.autoplay = false; // DON'T play - using Web Audio API only
    audio.playsInline = true;
    audio.volume = 0;
    audio.muted = true; // MUTED - Web Audio API will handle playback
    
    // Don't add to DOM - we only use Web Audio API for playback
    audio.style.display = 'none';
    
    console.log('  🔊 CONSUME: Audio element created and added to DOM');
    console.log('  🔊 CONSUME: Stream active:', stream.active);
    console.log('  🔊 CONSUME: Track count:', stream.getTracks().length);
    
    // CRITICAL FIX: Route through Web Audio API directly to speakers!
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      console.log('  🔊 Creating AudioContext, state:', audioContext.state);
      console.log('  🔊 AudioContext destination:', audioContext.destination);
      console.log('  🔊 Stream tracks:', stream.getTracks());
      console.log('  🔊 Track[0] readyState:', stream.getTracks()[0].readyState);
      console.log('  🔊 Track[0] enabled:', stream.getTracks()[0].enabled);
      console.log('  🔊 Track[0] muted:', stream.getTracks()[0].muted);
      
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
        console.log('  ✅ AudioContext resumed to:', audioContext.state);
      }
      
      // Create source from stream
      const source = audioContext.createMediaStreamSource(stream);
      console.log('  ✅ MediaStreamSource created:', source);
      
      // Create pre-gain (moderate boost)
      const preGain = audioContext.createGain();
      preGain.gain.value = 3.0; // Moderate 3x boost
      
      // Create dynamic compressor to prevent distortion and boost quiet parts
      const compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-30, audioContext.currentTime); // Start compressing at -30dB
      compressor.knee.setValueAtTime(20, audioContext.currentTime); // Smooth compression curve
      compressor.ratio.setValueAtTime(12, audioContext.currentTime); // Strong compression ratio
      compressor.attack.setValueAtTime(0.003, audioContext.currentTime); // Fast attack (3ms)
      compressor.release.setValueAtTime(0.25, audioContext.currentTime); // Quick release (250ms)
      
      // Create post-gain (final volume)
      const postGain = audioContext.createGain();
      postGain.gain.value = 2.0; // 2x after compression
      
      // Connect chain: source -> pre-gain -> compressor -> post-gain -> speakers
      source.connect(preGain);
      preGain.connect(compressor);
      compressor.connect(postGain);
      postGain.connect(audioContext.destination);
      
      console.log('  ✅ Audio chain connected:');
      console.log('    Source -> PreGain(3x) -> Compressor -> PostGain(2x) -> Speakers');
      console.log('  🔊 ✅ HIGH QUALITY AUDIO ROUTING COMPLETE!');
      
      // Store for cleanup
      if (participants.has(clientId)) {
        participants.get(clientId).audioContext = audioContext;
        participants.get(clientId).audioSource = source;
        participants.get(clientId).gainNode = postGain; // Store post-gain for volume control
      }
      
      // Monitor audio levels in real-time to see if voice is coming through
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      
      // Connect analyser AFTER post-gain to monitor final output
      postGain.connect(analyser);
      
      setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        const max = Math.max(...dataArray);
        
        if (average > 1 || max > 1) {
          console.log('  🔊 OUTPUT AUDIO LEVEL:', '█'.repeat(Math.floor(max / 10)), 'avg:', Math.round(average), 'max:', max);
        } else {
          console.log('  🔇 NO AUDIO DATA in output (silence or white noise only)');
        }
        
        console.log('  📊 AudioContext state:', audioContext.state, 'time:', Math.round(audioContext.currentTime));
        console.log('  📊 Stream active:', stream.active, 'Track readyState:', stream.getTracks()[0].readyState);
      }, 2000);
      
    } catch (e) {
      console.error('  ❌ Web Audio API failed:', e);
      console.error('  ❌ Stack:', e.stack);
    }

    console.log('  🔊 CONSUME: Audio element:', {
      paused: audio.paused,
      muted: audio.muted,
      volume: audio.volume,
      readyState: audio.readyState,
    });

    console.log('  🔊 CONSUME: Stream info:', {
      id: stream.id,
      active: stream.active,
      tracks: stream.getTracks().length,
    });

    // Set up audio level monitoring
    try {
      const audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let silenceCount = 0;
      let audioDetected = false;

      const checkAudioLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        const max = Math.max(...dataArray);

        if (average > 0 || max > 0) {
          if (!audioDetected) {
            console.log(
              '  🎵 AUDIO DETECTED! Average:',
              Math.round(average),
              'Max:',
              max,
            );
            console.log('  🔊 Audio element status:', {
              paused: audio.paused,
              muted: audio.muted,
              volume: audio.volume,
              currentTime: audio.currentTime,
              readyState: audio.readyState,
            });
            console.log('  🔊 Consumer track status:', {
              enabled: consumer.track.enabled,
              muted: consumer.track.muted,
              readyState: consumer.track.readyState,
            });
            console.log('  🔊 Stream active:', stream.active);
            audioDetected = true;
          }
          silenceCount = 0;

          // Log audio level periodically
          if (Math.random() < 0.05) {
            console.log(
              '  📊 Receiving Audio - avg:',
              Math.round(average),
              'max:',
              max,
              '█'.repeat(Math.floor(max / 10)),
            );
          }
        } else {
          silenceCount++;
          if (silenceCount === 10) {
            console.log('  🔇 Silence detected');
            console.log('  🔍 Audio element:', {
              paused: audio.paused,
              volume: audio.volume,
              muted: audio.muted,
            });
          }
        }
      };

      // Check audio levels periodically
      const levelCheckInterval = setInterval(checkAudioLevel, 100);

      // Store interval for cleanup
      if (!participants.has(clientId)) {
        participants.set(clientId, {
          audio,
          consumerId: id,
          levelCheckInterval,
        });
      } else {
        const participant = participants.get(clientId);
        participant.audio = audio;
        participant.consumerId = id;
        participant.levelCheckInterval = levelCheckInterval;
      }

      console.log('  ✅ CONSUME: Audio level monitoring enabled');
    } catch (e) {
      console.warn('  ⚠️ CONSUME: Could not set up audio monitoring:', e);
    }

    audio.onloadedmetadata = () => {
      console.log('  ✅ CONSUME: Audio metadata loaded');
    };

    audio.onplay = () => {
      console.log('  ▶️ CONSUME: Audio started playing!');
    };

    audio.onpause = () => {
      console.log('  ⏸️ CONSUME: Audio paused');
    };

    audio.onerror = (e) => {
      console.error('  ❌ CONSUME: Audio error:', e, audio.error);
    };

    audio.onvolumechange = () => {
      console.log('  🔊 CONSUME: Volume changed to:', audio.volume);
    };

    // Track events
    consumer.track.onended = () => {
      console.log('  ⚠️ CONSUME: Track ended');
    };

    consumer.track.onmute = () => {
      console.log('  🔇 CONSUME: Track muted');
    };

    consumer.track.onunmute = () => {
      console.log('  🔊 CONSUME: Track unmuted');
    };

    // Force play with proper timing
    setTimeout(() => {
      console.log('  🔊 CONSUME: Attempting to play audio...');
      const playPromise = audio.play();
      
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            console.log('  ✅ CONSUME: Audio playing successfully!');
            console.log('  🔊 Audio element in DOM:', document.body.contains(audio));
            console.log('  🔊 Audio paused:', audio.paused, 'Volume:', audio.volume);
          })
          .catch((e) => {
            console.warn('  ⚠️ CONSUME: Autoplay blocked:', e.message);
            console.log('  💡 Click anywhere on the page to enable audio');
            
            // Try to play on any user interaction
            const tryPlay = () => {
              console.log('  🔊 User clicked, trying to play audio...');
              audio.play()
                .then(() => {
                  console.log('  ✅ Audio started after user interaction!');
                  document.removeEventListener('click', tryPlay);
                })
                .catch(err => {
                  console.error('  ❌ Still failed:', err.message);
                });
            };
            document.addEventListener('click', tryPlay);
          });
      }
    }, 100); // Small delay to ensure stream is ready

    // Store audio element for cleanup
    if (!participants.has(clientId)) {
      participants.set(clientId, { audio, consumerId: id });
    } else {
      participants.get(clientId).audio = audio;
      participants.get(clientId).consumerId = id;
    }

    console.log(
      '  ✅ CONSUME: Complete! Consumer:',
      id,
      'for producer:',
      producerId,
    );

    // Add event listeners for debugging
    consumer.on('trackended', () => {
      console.log('  ⚠️ CONSUME: Consumer track ended:', id);
    });

    consumer.on('transportclose', () => {
      console.log('  ⚠️ CONSUME: Consumer transport closed:', id);
    });

    // Log stats periodically
    const statsInterval = setInterval(async () => {
      try {
        const stats = await consumer.getStats();
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            console.log('  📊 CONSUME Stats:', {
              packetsReceived: report.packetsReceived,
              packetsLost: report.packetsLost,
              bytesReceived: report.bytesReceived,
              jitter: report.jitter,
            });
          }
        });
      } catch (e) {
        console.error('  ❌ CONSUME: Error getting stats:', e);
      }
    }, 5000);

    // Store for cleanup
    const participant = participants.get(clientId);
    if (participant) {
      participant.statsInterval = statsInterval;
    }
  } catch (error) {
    console.error('  ❌ CONSUME: Failed to consume audio:', error);
  }
}

function toggleMute() {
  if (!producer) return;

  isMuted = !isMuted;

  if (isMuted) {
    producer.pause();
    muteBtn.textContent = '🔇 Unmute';
    muteBtn.classList.add('muted');
  } else {
    producer.resume();
    muteBtn.textContent = '🎤 Mute';
    muteBtn.classList.remove('muted');
  }
}

function leaveChannel() {
  // Stop audio stream
  if (audioStream) {
    audioStream.getTracks().forEach((track) => track.stop());
  }

  // Close transports
  if (sendTransport) sendTransport.close();
  if (recvTransport) recvTransport.close();

  // Stop all consumer audio
  for (const [, participant] of participants.entries()) {
    if (participant.audio) {
      participant.audio.pause();
      participant.audio.srcObject = null;
      // Remove from DOM
      if (document.body.contains(participant.audio)) {
        document.body.removeChild(participant.audio);
      }
    }
    if (participant.audioContext) {
      participant.audioContext.close();
    }
    if (participant.levelCheckInterval) {
      clearInterval(participant.levelCheckInterval);
    }
    if (participant.statsInterval) {
      clearInterval(participant.statsInterval);
    }
  }

  // Reset state
  producer = null;
  sendTransport = null;
  recvTransport = null;
  consumers.clear();
  participants.clear();
  currentRoomId = null;
  isMuted = false;

  // Reset UI
  joinSection.style.display = 'block';
  controlsSection.classList.remove('show');
  statusDiv.classList.remove('show');
  joinBtn.disabled = false;
  muteBtn.textContent = '🎤 Mute';
  muteBtn.classList.remove('muted');
  participantList.innerHTML =
    '<div class="empty-state">No participants yet</div>';

  // Disconnect and reconnect socket to properly clean up server state
  socket.disconnect();
  socket.connect();
}

function addParticipant(clientId, isMe = false) {
  if (participants.has(clientId) && participants.get(clientId).element) {
    return; // Already added
  }

  if (!participants.has(clientId)) {
    participants.set(clientId, {});
  }

  const participant = participants.get(clientId);

  // Remove empty state if exists
  const emptyState = participantList.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const el = document.createElement('div');
  el.className = 'participant';
  el.innerHTML = `
    <div class="participant-icon">${clientId.substring(0, 2).toUpperCase()}</div>
    <div class="participant-info">
      <div class="participant-name">${isMe ? 'You' : `User ${clientId.substring(0, 8)}`}</div>
      ${isMe ? '<div class="participant-you">(You)</div>' : ''}
    </div>
    <div class="audio-indicator"></div>
  `;

  participantList.appendChild(el);
  participant.element = el;
}

function removeParticipant(clientId) {
  const participant = participants.get(clientId);
  if (participant) {
    if (participant.element) {
      participant.element.remove();
    }
    if (participant.audio) {
      participant.audio.pause();
      participant.audio.srcObject = null;
      // Remove from DOM
      if (document.body.contains(participant.audio)) {
        document.body.removeChild(participant.audio);
      }
    }
    if (participant.audioContext) {
      participant.audioContext.close();
    }
    if (participant.levelCheckInterval) {
      clearInterval(participant.levelCheckInterval);
    }
    if (participant.statsInterval) {
      clearInterval(participant.statsInterval);
    }
    participants.delete(clientId);
  }

  // Show empty state if no participants
  if (participantList.children.length === 0) {
    participantList.innerHTML =
      '<div class="empty-state">No participants yet</div>';
  }
}

function showStatus(message, type) {
  statusDiv.textContent = message;
  statusDiv.className = `status show ${type}`;
}
