// /api/auth/* — login, logout and password flows in one serverless function.
// See api/_handlers/dispatch.js for why the routes are grouped this way. Each
// handler keeps its own throttling and validation; this file only routes.

import { makeDispatcher } from '../_handlers/dispatch.js';

import adminLogin from '../_handlers/auth/admin-login.js';
import forgotPassword from '../_handlers/auth/forgot-password.js';
import investorLogin from '../_handlers/auth/investor-login.js';
import logout from '../_handlers/auth/logout.js';
import setPassword from '../_handlers/auth/set-password.js';

export default makeDispatcher({
  'admin-login': adminLogin,
  'forgot-password': forgotPassword,
  'investor-login': investorLogin,
  logout,
  'set-password': setPassword,
});
