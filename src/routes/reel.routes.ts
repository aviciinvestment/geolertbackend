import { Router } from 'express';
import multer from 'multer';
import ReelController from '../controllers/reel.controller';
import { protect } from '../utils/authMiddleware';

const router = Router();

const upload = multer({ dest: 'uploads/' });

router.use(protect);

router.get('/analytics', ReelController.getAnalytics);
router.get('/feed', ReelController.getFeed);
router.post('/upload', upload.single('video'), ReelController.uploadReel);
router.post('/live', ReelController.startLiveStream);

router.post('/:id/like', ReelController.likeReel);
router.post('/:id/view', ReelController.viewReel);
router.get('/:id/comments', ReelController.getComments);
router.post('/:id/comments', ReelController.addComment);
router.post('/:id/comments/video', upload.single('video'), ReelController.addVideoComment);
router.patch('/:id/resolve', ReelController.resolveReel);

export default router;
