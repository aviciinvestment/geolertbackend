import express from 'express';
import multer from 'multer';
import { register, login, googleLogin, getMe, updateProfile, uploadAvatar, updateLocation } from '../controllers/authController';
import { protect } from '../utils/authMiddleware';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.post('/register', register);
router.post('/login', login);
router.post('/google', googleLogin);
router.get('/me', protect, getMe);
router.put('/me', protect, updateProfile);
router.put('/location', protect, updateLocation);
router.post('/avatar', protect, upload.single('avatar'), uploadAvatar);

export default router;
