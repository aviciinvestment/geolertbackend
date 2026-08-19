import { Router } from 'express';
import UserController from '../controllers/user.controller';
import { protect } from '../utils/authMiddleware';

const router = Router();

router.get('/:id', protect, UserController.getProfile);

export default router;
