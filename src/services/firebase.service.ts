import { initializeApp, getApps, getApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const app = getApps().length === 0 ? initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID || 'achivsecurities-65426',
}) : getApp();

export const firebaseAdminAuth = getAuth(app);
