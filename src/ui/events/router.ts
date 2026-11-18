/**
 * Routes delegated clicks and form changes to the handlers of each area, in a fixed order:
 * dialogs and help first, then `data-action` buttons, then exports, tools, results controls,
 * and finally the photo list.
 */
import type { ActionHandler, ControlLike, ElementLike, EventContext } from './context.js';
import { dashboardActions, handleDashboardChange, handleDashboardClick } from './dashboard.js';
import { dialogActions, handleDialogClick, handleExportClick } from './dialogs.js';
import { handleSidebarChange, handleSidebarClick, sidebarActions } from './sidebar.js';
import { handleToolbarChange, handleToolbarClick, toolbarActions } from './toolbar.js';

export const ACTIONS: Record<string, ActionHandler> = {
  ...sidebarActions,
  ...toolbarActions,
  ...dashboardActions,
  ...dialogActions,
};

export function routeClick(target: ElementLike, preventDefault: () => void, ctx: EventContext): void {
  if (handleDialogClick(target, preventDefault, ctx)) return;
  const actionEl = target.closest('[data-action]');
  if (actionEl) {
    const act = actionEl.dataset['action'];
    if (act !== undefined && Object.prototype.hasOwnProperty.call(ACTIONS, act)) ACTIONS[act]!(actionEl, ctx);
    return;
  }
  if (handleExportClick(target, ctx)) return;
  if (handleToolbarClick(target, ctx)) return;
  if (handleDashboardClick(target, ctx)) return;
  handleSidebarClick(target, ctx);
}

export function routeChange(target: ControlLike, ctx: EventContext): void {
  if (target.id === 'site-select') {
    handleSidebarChange(target, ctx);
    return;
  }
  // Same order as before the split: calibration preset, photo list, Display menu, settings, compare, site options.
  if (handleToolbarChange(target, ctx)) return;
  if (handleSidebarChange(target, ctx)) return;
  handleDashboardChange(target, ctx);
}
