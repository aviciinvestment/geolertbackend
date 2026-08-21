import http from 'http';
import { Server } from 'socket.io';
import app from './app';
import { connectDB } from './utils/db';

const PORT = process.env.PORT || 5000;

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://geolertfrontend.onrender.com';

const server = http.createServer(app);

export const io = new Server(server, {
  cors: {
    origin: [FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

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
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
