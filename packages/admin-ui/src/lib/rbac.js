/** Role gating helpers. superadmin: everything. admin: users/sessions/usage/audit + dashboard. user: own sessions + settings. */
export const isSuperadmin = (u) => u?.role === 'superadmin';
export const isAdmin = (u) => u?.role === 'admin' || u?.role === 'superadmin';

/** Which routes each role may open. */
export const ROUTE_ACCESS = {
  dashboard: ['superadmin', 'admin', 'user'],
  users: ['superadmin', 'admin'],
  ai: ['superadmin'],
  clients: ['superadmin'],
  client: ['superadmin'],
  knowledge: ['superadmin'],
  skills: ['superadmin'],
  skill: ['superadmin'],
  sessions: ['superadmin', 'admin', 'user'],
  session: ['superadmin', 'admin', 'user'],
  usage: ['superadmin', 'admin'],
  audit: ['superadmin', 'admin'],
  settings: ['superadmin', 'admin', 'user'],
  pair: ['superadmin', 'admin', 'user'],
  oauthResult: ['superadmin', 'admin', 'user'],
  policy: ['superadmin'],
  notFound: ['superadmin', 'admin', 'user'],
};

export function canAccess(user, routeName) {
  const allowed = ROUTE_ACCESS[routeName];
  if (!allowed) return true;
  return !!user && allowed.includes(user.role);
}

export const NAV_SECTIONS = [
  {
    id: 'main',
    label: 'Overview',
    items: [
      { id: 'dashboard', label: 'Dashboard', path: '/', icon: 'dashboard' },
      { id: 'sessions', label: 'Sessions', path: '/sessions', icon: 'sessions' },
      { id: 'usage', label: 'Usage', path: '/usage', icon: 'usage' },
    ],
  },
  {
    id: 'manage',
    label: 'Manage',
    items: [
      { id: 'users', label: 'Users', path: '/users', icon: 'users' },
      { id: 'clients', label: 'Clients', path: '/clients', icon: 'clients' },
      { id: 'skills', label: 'Skills', path: '/skills', icon: 'skills' },
      { id: 'knowledge', label: 'Knowledge', path: '/knowledge', icon: 'docs' },
      { id: 'policy', label: 'Policy', path: '/policy', icon: 'shield' },
      { id: 'ai', label: 'AI models', path: '/ai', icon: 'ai' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'audit', label: 'Audit log', path: '/audit', icon: 'audit' },
      { id: 'pair', label: 'Pair extension', path: '/pair', icon: 'pair' },
      { id: 'settings', label: 'Settings', path: '/settings', icon: 'settings' },
    ],
  },
];

export function navForUser(user) {
  return NAV_SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => canAccess(user, i.id)) })).filter((s) => s.items.length);
}
