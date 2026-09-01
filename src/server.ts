import http from 'http';
import { Server } from 'socket.io';
import app from './app';
import { connectDB } from './utils/db';
import ReelService from './services/reel.service';

const PORT = process.env.PORT || 5000;

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://geolertfrontend.onrender.com';

const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  'https://achivsecurities.vercel.app',
  'http://localhost:5173',
  'https://localhost:5173',
  'http://localhost:3000',
];

const server = http.createServer(app);

export const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  socket.on('join_user', (userId: string) => {
    if (typeof userId === 'string' && userId) {
      socket.join(`user:${userId}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const startServer = async () => {
  try {
    await connectDB();
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    // Background: reverse-geocode legacy reports so jurisdiction dashboards
    // can scope them by state/LGA. Non-blocking; throttled + cached.
    ReelService.ensureRegionsBackfilled(true).catch((err) =>
      console.error('[Startup] Region backfill failed:', err?.message || err)
    );
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Only boot the HTTP server when this file is the entrypoint. Services import
// `io` from here; guarding keeps utility/test scripts from second-server crashes.
if (require.main === module) {
  startServer();
} else {
  console.log('[server] loaded as module (skipping startup)');
}
