import { Router } from 'express';
import NotificationController from '../controllers/notification.controller';
import { protect } from '../utils/authMiddleware';

const router = Router();

router.get('/', protect, NotificationController.getNotifications);
router.put('/read', protect, NotificationController.markAllRead);

export default router;