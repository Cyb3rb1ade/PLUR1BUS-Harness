#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    pid_t child = fork();
    if (child < 0) return 2;
    if (child == 0) _exit(0);
    siginfo_t state = {0};
    if (waitid(P_PID, child, &state, WEXITED | WNOWAIT) || state.si_pid != child) return 3;
    DIR *proc = opendir("/proc");
    if (!proc) return 4;
    unsigned total = 0, payload = 0;
    struct dirent *entry;
    while ((entry = readdir(proc)) != NULL) {
        char *end;
        long pid = strtol(entry->d_name, &end, 10);
        if (!*entry->d_name || *end || pid <= 0) continue;
        ++total;
        if (pid != 1) {
            ++payload;
            if (pid != getpid() && pid != child) return 5;
        }
    }
    closedir(proc);
    errno = 0;
    pid_t blocked = fork();
    int error = errno;
    if (blocked == 0) _exit(0);
    if (blocked > 0) { waitpid(blocked, NULL, 0); fputs("fork unexpectedly succeeded\n", stderr); return 6; }
    if (total != 3 || payload != 2 || error != EAGAIN) return 7;
    char userns[128];
    ssize_t n = readlink("/proc/self/ns/user", userns, sizeof(userns) - 1);
    if (n < 0 || (size_t)n >= sizeof(userns) - 1) return 17;
    userns[n] = '\0';
    unsigned long inside, outside, length;
    FILE *uid_map = fopen("/proc/self/uid_map", "r");
    if (!uid_map) return 18;
    int mapped = fscanf(uid_map, "%lu %lu %lu", &inside, &outside, &length);
    fclose(uid_map);
    if (mapped != 3 || (unsigned long)getuid() < inside || (unsigned long)getuid() - inside >= length) return 19;
    outside += (unsigned long)getuid() - inside;
    if (printf("ready total=%u payload=%u errno=%d uid=%lu map-outside=%lu userns=%s\n", total, payload, error,
               (unsigned long)getuid(), outside, userns) < 0 || fflush(stdout)) return 8;
    char ack;
    if (read(STDIN_FILENO, &ack, 1) != 1) return 9;
    errno = 0;
    pid_t still_blocked = fork();
    error = errno;
    if (still_blocked == 0) _exit(0);
    if (still_blocked > 0) { waitpid(still_blocked, NULL, 0); return 13; }
    if (error != EAGAIN) return 14;
    if (puts("still limited") == EOF || fflush(stdout)) return 15;
    if (read(STDIN_FILENO, &ack, 1) != 1) return 16;
    if (waitpid(child, NULL, 0) != child) return 10;
    pid_t control = fork();
    if (control < 0) return 11;
    if (control == 0) _exit(0);
    if (waitpid(control, NULL, 0) != control) return 12;
    puts("after-reap fork succeeded");
    return 0;
}
