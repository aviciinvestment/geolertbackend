import { Router } from 'express';
import BroadcastController from '../controllers/broadcast.controller';
import { protect, authorize } from '../utils/authMiddleware';

const router = Router();

router.post(
  '/',
  protect,
  authorize('admin', 'superadmin'),
  BroadcastController.sendBroadcast
);

export default router;