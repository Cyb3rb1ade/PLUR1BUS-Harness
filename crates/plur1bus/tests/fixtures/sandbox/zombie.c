#include <signal.h>
#include <stdio.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    pid_t child = fork();
    if (child < 0) return 2;
    if (child == 0) _exit(0);
    siginfo_t info = {0};
    if (waitid(P_PID, child, &info, WEXITED | WNOWAIT) != 0 || info.si_pid != child) return 3;
    if (printf("%ld\n", (long)child) < 0 || fflush(stdout) != 0) return 4;
    char ack;
    if (read(STDIN_FILENO, &ack, 1) != 1) return 5;
    return waitpid(child, NULL, 0) == child ? 0 : 6;
}
