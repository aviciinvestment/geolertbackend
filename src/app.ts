import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import reelRoutes from './routes/reel.routes';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/user.routes';
import geminiRoutes from './routes/gemini.routes';
import broadcastRoutes from './routes/broadcast.routes';
import notificationRoutes from './routes/notification.routes';
import founderRoutes from './routes/founder.routes';
dotenv.config();

const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://geolertfrontend.onrender.com';

const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  'https://achivsecurities.vercel.app',
  'http://localhost:5173',
  'https://localhost:5173',
  'http://localhost:3000',
];

// CORS
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend build in production
const clientDist = path.join(__dirname, '../../dist');
app.use(express.static(clientDist));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/reels', reelRoutes);
app.use('/api/users', userRoutes);
app.use('/api/gemini', geminiRoutes);
app.use('/api/broadcast', broadcastRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/founder', founderRoutes);
// Health check
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', message: 'Backend is running' });
});

// SPA fallback — serve index.html for all non-API GET routes
// (Express 5 requires a named wildcard instead of '*')
app.get('/*splat', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) {
      res.status(404).json({ message: 'Not found' });
    }
  });
});

export default app;
