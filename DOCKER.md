# Docker Setup Guide

## 📦 What's Included

- **Dockerfile**: Multi-stage build optimized for NestJS + Mediasoup
- **docker-compose.yml**: Full stack with SFU, PostgreSQL, and Hasura

## 🚀 Quick Start

### 1. Environment Variables

Create a `.env` file in the project root:

```bash
# Server Configuration
PORT=3000
HOST=0.0.0.0

# Public URL (for frontend to connect)
PUBLIC_URL=http://localhost:3000

# WebRTC Configuration
RTC_MIN_PORT=40000
RTC_MAX_PORT=40100

# Announced IP for WebRTC
ANNOUNCED_IP=127.0.0.1

# Environment
NODE_ENV=production
```

### 2. Build and Run

```bash
# Build and start all services
docker-compose up -d --build

# View logs
docker-compose logs -f sfu

# Stop all services
docker-compose down
```

### 3. Access Services

- **SFU Application**: http://localhost:3000
- **Hasura Console**: http://localhost:8080
- **PostgreSQL**: localhost:5432

## 🔧 Configuration

### Ports Exposed

- `3000` - HTTP/WebSocket server
- `40000-40100/udp` - WebRTC media (UDP)
- `40000-40100/tcp` - WebRTC media (TCP)

**Note**: Docker limits the RTC port range to 101 ports (40000-40100) instead of the full 10,000 range. This is sufficient for most use cases (each connection uses ~2 ports).

### Environment Variables in docker-compose.yml

You can override these in the `.env` file or directly in `docker-compose.yml`:

- `PUBLIC_URL` - The URL clients use to connect
- `ANNOUNCED_IP` - The IP address for WebRTC (use your server's public IP in production)
- `RTC_MIN_PORT` / `RTC_MAX_PORT` - Port range for WebRTC

## 🌍 Production Deployment

### Option 1: Docker on a VM with Public IP

1. Set your public IP in `.env`:
   ```bash
   ANNOUNCED_IP=YOUR_PUBLIC_IP
   PUBLIC_URL=https://your-domain.com
   ```

2. Expose ports in firewall:
   ```bash
   sudo ufw allow 3000/tcp
   sudo ufw allow 40000:40100/udp
   sudo ufw allow 40000:40100/tcp
   ```

3. Run behind Nginx (recommended):
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

### Option 2: Using ngrok (Development/Testing)

1. Start ngrok:
   ```bash
   ngrok http 3000
   ```

2. Update `.env` with ngrok URL:
   ```bash
   PUBLIC_URL=https://your-url.ngrok-free.app
   ANNOUNCED_IP=YOUR_PUBLIC_IP
   ```

3. Restart container:
   ```bash
   docker-compose restart sfu
   ```

## 🔍 Debugging

### View Container Logs
```bash
docker-compose logs -f sfu
```

### Enter Container Shell
```bash
docker-compose exec sfu sh
```

### Check Port Bindings
```bash
docker-compose ps
docker port sample-sfu
```

### Rebuild from Scratch
```bash
docker-compose down -v
docker-compose build --no-cache
docker-compose up -d
```

## 📊 Resource Requirements

### Minimum
- CPU: 2 cores
- RAM: 2GB
- Disk: 10GB

### Recommended (for 10-20 concurrent users)
- CPU: 4 cores
- RAM: 4GB
- Disk: 20GB

## 🛠️ Development Mode

For development with hot-reload, use the local npm commands instead:

```bash
npm run start:dev
```

The Docker setup is optimized for production deployments.

## 🔒 Security Notes

1. **Change Hasura Admin Secret** in production
2. **Use HTTPS** (not HTTP) with SSL certificates
3. **Limit RTC ports** based on expected concurrent users
4. **Set strong PostgreSQL password**
5. **Use environment variables** for secrets (never commit `.env`)

## 📞 Troubleshooting

### Issue: "Cannot connect to server"
- Check if container is running: `docker-compose ps`
- Check logs: `docker-compose logs sfu`
- Verify PUBLIC_URL matches your access URL

### Issue: "No audio/video"
- Verify ANNOUNCED_IP is set to your public IP
- Check firewall allows RTC ports (40000-40100)
- Ensure browser has mic/camera permissions

### Issue: "Build fails"
- Clear Docker cache: `docker system prune -a`
- Rebuild: `docker-compose build --no-cache`

## 🎯 Performance Tuning

### For More Concurrent Users

Increase RTC port range in `docker-compose.yml`:

```yaml
ports:
  - "40000-40200:40000-40200/udp"  # 201 ports
  - "40000-40200:40000-40200/tcp"
```

And update `.env`:
```bash
RTC_MAX_PORT=40200
```

**Rule of thumb**: Each user needs ~2 ports (one for send, one for receive).

