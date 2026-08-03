const appDatabase = process.env.MONGO_INITDB_DATABASE || 'pxm';
const appUser = process.env.PXM_MONGO_APP_USER || 'pxm_app';
const appPassword = process.env.PXM_MONGO_APP_PASSWORD;

if (!appPassword || appPassword.length < 24) {
  throw new Error('PXM_MONGO_APP_PASSWORD must be at least 24 characters');
}

db.getSiblingDB(appDatabase).createUser({
  user: appUser,
  pwd: appPassword,
  roles: [{ role: 'readWrite', db: appDatabase }],
});
