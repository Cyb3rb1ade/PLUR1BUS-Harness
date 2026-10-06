export const lifecycleFields = ['second_instance_focus', 'spa_focus', 'close_hides', 'close_minimizes', 'shell_focus', 'quit_modal_default', 'quit_cancel_preserves_app', 'quit_confirm_exits'];
export const launcherSkip = 'skipped(launcher-no-foreground)';
// A skip is resolved fixture work, not native focus acceptance. Windows CI
// requires independent strict x64 coverage in its matrix summary.
export function lifecycleFailure(report, {allowWindowsSkip = false} = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return 'invalid-report';
  const skipped = allowWindowsSkip && report.second_instance_focus_mode === launcherSkip && report.second_instance_focus === launcherSkip;
  if (!skipped && report.second_instance_focus_mode !== 'strict') return 'second_instance_focus_mode';
  const failed = lifecycleFields.filter(field => !(skipped && field === 'second_instance_focus') && report[field] !== true);
  if (failed.length) return failed.join(',');
  if (Object.keys(report).sort().join(',') !== [...lifecycleFields, 'second_instance_focus_mode'].sort().join(',')) return 'extra-fields';
}
