export const lifecycleFields = ['second_instance_focus', 'spa_focus', 'close_hides', 'close_minimizes', 'shell_focus', 'quit_modal_default', 'quit_cancel_preserves_app', 'quit_confirm_exits'];
// A local-only second-instance check can never satisfy native acceptance.
export function lifecycleFailure(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return 'invalid-report';
  if (report.second_instance_focus_mode !== 'strict') return 'second_instance_focus_mode';
  const failed = lifecycleFields.filter(field => report[field] !== true);
  if (failed.length) return failed.join(',');
  if (Object.keys(report).sort().join(',') !== [...lifecycleFields, 'second_instance_focus_mode'].sort().join(',')) return 'extra-fields';
}
