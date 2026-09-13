import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { toast, confirm } from '../../../lib/store.js';

/** Projects for a client + task board of the selected project. */
export default class ProjectsTab extends LightningElement {
  static renderMode = 'light';
  @api clientId;
  projects = [];
  tasks = [];
  orgs = [];
  users = [];
  selectedId = null;
  loading = true;
  tasksLoading = false;
  error = null;
  tasksError = null;
  projectModal = false;
  projectForm = { name: '', description: '' };
  taskModal = false;
  taskForm = null;
  editingTask = null;
  busy = false;

  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      const [projects, orgs, users] = await Promise.all([
        Api.listProjects(this.clientId).then((r) => asList(r, 'projects')),
        Api.listOrgs(this.clientId)
          .then((r) => asList(r, 'orgs'))
          .catch(() => []),
        Api.listUsers()
          .then((r) => asList(r, 'users'))
          .catch(() => []),
      ]);
      this.projects = projects.filter((p) => !p.clientId || p.clientId === this.clientId);
      this.orgs = orgs;
      this.users = users.filter((u) => u.status === 'active');
      if (!this.selectedId && this.projects.length) this.selectedId = this.projects[0].id;
      if (this.selectedId) await this.loadTasks();
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  async loadTasks() {
    this.tasksLoading = true;
    this.tasksError = null;
    try {
      this.tasks = asList(await Api.listTasks({ projectId: this.selectedId }), 'tasks');
    } catch (e) {
      this.tasksError = e;
    } finally {
      this.tasksLoading = false;
    }
  }
  get hasProjects() {
    return this.projects.length > 0;
  }
  get selected() {
    return this.projects.find((p) => p.id === this.selectedId);
  }
  get projectItems() {
    return this.projects.map((p) => ({
      ...p,
      cls: `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${p.id === this.selectedId ? 'bg-brand-50 font-medium text-brand-700 ring-1 ring-inset ring-brand-500/30' : 'text-content hover:bg-surface-sunken'}`,
      archived: p.status === 'archived',
      count: this.tasks.filter((t) => t.projectId === p.id).length,
    }));
  }
  get columns() {
    const defs = [
      { id: 'open', label: 'Open', color: 'border-t-sky-500' },
      { id: 'in_progress', label: 'In progress', color: 'border-t-brand-500' },
      { id: 'blocked', label: 'Blocked', color: 'border-t-amber-500' },
      { id: 'done', label: 'Done', color: 'border-t-emerald-500' },
      { id: 'cancelled', label: 'Cancelled', color: 'border-t-slate-600' },
    ];
    return defs.map((c) => {
      const items = this.tasks
        .filter((t) => t.status === c.id)
        .map((t) => ({
          ...t,
          assignee: this.users.find((u) => u.id === t.assigneeId)?.displayName || (t.assigneeId ? 'Unknown user' : ''),
          org: this.orgs.find((o) => o.id === t.orgId)?.label || '',
          sessionsHref: `#/sessions?taskId=${t.id}`,
        }));
      return { ...c, items, count: items.length, cls: `card flex min-h-40 flex-col border-t-2 ${c.color}`, hasItems: items.length > 0 };
    });
  }
  get statusOptions() {
    return this.columns.map((c) => ({ value: c.id, label: c.label }));
  }
  get orgOptions() {
    return this.orgs.map((o) => ({ value: o.id, label: `${o.label} (${o.kind})` }));
  }
  get userOptions() {
    return this.users.map((u) => ({ value: u.id, label: u.displayName || u.email }));
  }
  get taskModalTitle() {
    return this.editingTask ? 'Edit task' : 'New task';
  }
  get tf() {
    return this.taskForm || {};
  }
  get cannotSaveTask() {
    return this.busy || !this.tf.title?.trim();
  }
  get cannotSaveProject() {
    return this.busy || !this.projectForm.name.trim();
  }
  get isEditingTask() {
    return !!this.editingTask;
  }
  get selectedArchived() {
    return this.selected?.status === 'archived';
  }
  get archiveLabel() {
    return this.selectedArchived ? 'Unarchive' : 'Archive';
  }

  selectProject(e) {
    this.selectedId = e.currentTarget.dataset.id;
    this.loadTasks();
  }
  openProject() {
    this.projectForm = { name: '', description: '' };
    this.projectModal = true;
  }
  closeProject() {
    this.projectModal = false;
  }
  handleProjectField(e) {
    this.projectForm = { ...this.projectForm, [e.detail.name]: e.detail.value };
  }
  async createProject() {
    this.busy = true;
    try {
      const body = { clientId: this.clientId, name: this.projectForm.name.trim() };
      if (this.projectForm.description.trim()) body.description = this.projectForm.description.trim();
      const p = await Api.createProject(body);
      toast.success('Project created');
      this.projectModal = false;
      if (p?.id) this.selectedId = p.id;
      await this.load();
    } catch (err) {
      toast.error('Could not create project', err.message);
    } finally {
      this.busy = false;
    }
  }
  async toggleArchive() {
    const p = this.selected;
    if (!p) return;
    const status = p.status === 'archived' ? 'active' : 'archived';
    try {
      await Api.updateProject(p.id, { status });
      toast.success(`Project ${status}`);
      await this.load();
    } catch (err) {
      toast.error('Could not update project', err.message);
    }
  }
  openTask() {
    this.editingTask = null;
    this.taskForm = { title: '', description: '', status: 'open', assigneeId: '', orgId: '' };
    this.taskModal = true;
  }
  editTask(e) {
    const t = this.tasks.find((x) => x.id === e.currentTarget.dataset.id);
    if (!t) return;
    this.editingTask = t;
    this.taskForm = { title: t.title, description: t.description || '', status: t.status, assigneeId: t.assigneeId || '', orgId: t.orgId || '' };
    this.taskModal = true;
  }
  closeTask() {
    this.taskModal = false;
  }
  handleTaskField(e) {
    this.taskForm = { ...this.taskForm, [e.detail.name]: e.detail.value };
  }
  async saveTask() {
    this.busy = true;
    const f = this.taskForm;
    try {
      if (this.editingTask) {
        await Api.updateTask(this.editingTask.id, {
          title: f.title.trim(),
          description: f.description,
          status: f.status,
          assigneeId: f.assigneeId || null,
          orgId: f.orgId || null,
        });
        toast.success('Task updated');
      } else {
        const body = { projectId: this.selectedId, title: f.title.trim() };
        if (f.description?.trim()) body.description = f.description.trim();
        if (f.assigneeId) body.assigneeId = f.assigneeId;
        if (f.orgId) body.orgId = f.orgId;
        const t = await Api.createTask(body);
        if (t?.id && f.status && f.status !== 'open') await Api.updateTask(t.id, { status: f.status });
        toast.success('Task created');
      }
      this.taskModal = false;
      await this.loadTasks();
    } catch (err) {
      toast.error('Could not save task', err.message);
    } finally {
      this.busy = false;
    }
  }
  async deleteTask() {
    const t = this.editingTask;
    if (!t) return;
    if (!(await confirm({ title: `Delete "${t.title}"?`, message: 'Sessions linked to this task keep their history.', confirmLabel: 'Delete', danger: true })))
      return;
    try {
      await Api.deleteTask(t.id);
      toast.success('Task deleted');
      this.taskModal = false;
      await this.loadTasks();
    } catch (err) {
      toast.error('Could not delete task', err.message);
    }
  }
}
