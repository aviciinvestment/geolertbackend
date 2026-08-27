import { Router } from 'express';
import UserController from '../controllers/user.controller';
import { protect, authorize } from '../utils/authMiddleware';

const router = Router();

router.get('/subordinates', protect, authorize('admin', 'superadmin'), UserController.getSubordinates);
router.get('/:id', protect, UserController.getProfile);

export default router;
