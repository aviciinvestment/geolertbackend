import { Router } from 'express';
import FounderController from '../controllers/founder.controller';
import { protect, authorize } from '../utils/authMiddleware';

const router = Router();

// Protect all routes with 'founder' role check
router.use(protect);
router.use(authorize('founder'));

router.get('/dashboard', FounderController.getGlobalDashboard);
router.get('/users', FounderController.getAllUsersGrouped);

export default router;
