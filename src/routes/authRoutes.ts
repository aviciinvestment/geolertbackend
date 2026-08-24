import express from 'express';
import multer from 'multer';
import {
  register,
  login,
  googleLogin,
  getMe,
  updateProfile,
  uploadAvatar,
  updateLocation,
  getPendingApprovals,
  reviewApproval,
  onboardSuperAdmin,
  onboardAdmin,
  onboardAuthority,
} from '../controllers/authController';
import { protect, authorize } from '../utils/authMiddleware';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.post('/register', register);
router.post('/login', login);
router.post('/google', googleLogin);
router.get('/me', protect, getMe);
router.put('/me', protect, updateProfile);
router.put('/location', protect, updateLocation);
router.post('/avatar', protect, upload.single('avatar'), uploadAvatar);

// Authorization chain: Super Admin approves Admins, Admin approves Authority Responders
router.get('/approvals', protect, authorize('superadmin', 'admin'), getPendingApprovals);
router.put('/approvals/:id', protect, authorize('superadmin', 'admin'), reviewApproval);

// Only an existing Super Admin can onboard additional Super Admins
router.post('/onboard/superadmin', protect, authorize('superadmin'), onboardSuperAdmin);

// Only an existing Super Admin can onboard Local Admins
router.post('/onboard/admin', protect, authorize('superadmin'), onboardAdmin);

// Only an approved Local Admin can onboard Authority Responders (scoped to their LGA)
router.post('/onboard/authority', protect, authorize('admin'), onboardAuthority);

export default router;
