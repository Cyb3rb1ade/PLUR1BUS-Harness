/* Read Darwin's SDK-defined structure, exposing only fixed-width scalar fields. */
#include <stdint.h>
#include <string.h>
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/proc.h>

struct watchdog_kernel_identity {
    uint64_t start_seconds, start_micros;
    uint32_t ppid, pgid, status;
};

int watchdog_kernel_identity(int pid, struct watchdog_kernel_identity *out) {
    struct kinfo_proc info;
    memset(&info, 0, sizeof(info));
    size_t size = sizeof(info);
    int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
    if (sysctl(mib, 4, &info, &size, NULL, 0) != 0 || size != sizeof(info)) return -1;
    out->start_seconds = (uint64_t)info.kp_proc.p_starttime.tv_sec;
    out->start_micros = (uint64_t)info.kp_proc.p_starttime.tv_usec;
    out->ppid = (uint32_t)info.kp_eproc.e_ppid;
    out->pgid = (uint32_t)info.kp_eproc.e_pgid;
    out->status = (uint32_t)info.kp_proc.p_stat;
    return 0;
}
