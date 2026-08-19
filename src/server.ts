import http from 'http';
import { Server } from 'socket.io';
import app from './app';
import { connectDB } from './utils/db';

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

// Setup Socket.io for real-time features
export const io = new Server(server, {
  cors: {
    origin: '*', // For development, allow all. In production, specify frontend URL
    methods: ['GET', 'POST']
  }
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
