// Combines macOS responsibility attribution with stable parent identities.
// Cached ancestry keeps observed detached children identifiable after parents exit.
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <spawn.h>
#include <libproc.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <stdint.h>
#include <string.h>

// Layout of the macOS PROC_PIDUNIQIDENTIFIERINFO ABI (flavor 17).
struct identity { unsigned char uuid[16]; uint64_t unique, parent; int32_t version, original_parent_version; uint64_t reserved[2]; };
static uint64_t known[32768];
static int known_count;
static int has(uint64_t id) { for(int i=0;i<known_count;i++) if(known[i]==id)return 1; return 0; }
static void remember(uint64_t id) { if(!has(id) && known_count<32768)known[known_count++]=id; }
static int identify(pid_t pid, struct identity *id) { return proc_pidinfo(pid,17,1,id,sizeof(*id)) == sizeof(*id); }

#define LIMIT 32768
extern char **environ;
static volatile sig_atomic_t stopping = 0;
static void stop(int number) { (void)number; stopping = 1; }
int main(int argc, char **argv) {
  if (argc < 2) return 125;
  pid_t (*responsible)(pid_t) = dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
  int (*disclaim)(posix_spawnattr_t *, int) = dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (!responsible || !disclaim) return 125;
  // Launch a dedicated supervisor whose responsibility identity stays alive
  // until cleanup, so attribution survives even an immediate double fork.
  if(strcmp(argv[1],"--supervise")) {
    posix_spawnattr_t attributes;
    if(posix_spawnattr_init(&attributes))return 125;
    if(posix_spawnattr_setflags(&attributes,POSIX_SPAWN_SETSID)||disclaim(&attributes,1))return 125;
    char **arguments=calloc((size_t)argc+2,sizeof(char *));if(!arguments)return 125;
    arguments[0]=argv[0];arguments[1]="--supervise";
    for(int i=1;i<argc;i++)arguments[i+1]=argv[i];
    struct sigaction action={0};action.sa_handler=stop;
    sigaction(SIGTERM,&action,NULL);sigaction(SIGINT,&action,NULL);
    pid_t supervisor;
    int error=posix_spawn(&supervisor,argv[0],NULL,&attributes,arguments,environ);
    posix_spawnattr_destroy(&attributes);free(arguments);if(error)return 125;
    int status;
    for(;;) {
      if(stopping)kill(supervisor,SIGTERM);
      pid_t reaped=waitpid(supervisor,&status,WNOHANG);
      if(reaped==supervisor)break;
      if(reaped<0 && errno!=EINTR)return 125;
      usleep(10000);
    }
    return WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);
  }
  argv++;argc--;if(argc<2)return 125;
  if(responsible(getpid())!=getpid())return 125;
  struct sigaction action = {0}; action.sa_handler = stop;
  sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL);
  posix_spawnattr_t attributes;
  if (posix_spawnattr_init(&attributes)) return 125;
  if (posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSID)) return 125;
  pid_t leader;
  int error = posix_spawn(&leader, argv[1], NULL, &attributes, argv + 1, environ);
  posix_spawnattr_destroy(&attributes);
  if (error) return 125;
  struct identity initial;
  if(!identify(leader,&initial)){kill(leader,SIGKILL);waitpid(leader,NULL,0);return 125;}
  remember(initial.unique);
  int status = 0, done = 0, quiet = 0;
  // Keep the leader unreaped until cleanup so its PID cannot be reused.
  for (;;) {
    siginfo_t info = {0};
    if (waitid(P_PID, leader, &info, WEXITED | WNOHANG | WNOWAIT) == 0 && info.si_pid == leader) { done = 1; stopping = 1; }
    pid_t pids[LIMIT];
    int bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, sizeof(pids));
    if (bytes <= 0 || bytes >= (int)sizeof(pids)) { stopping = 1; kill(-leader, SIGKILL); }
    int descendants = 0;
    // Stable process identities avoid killing a reused PID. Retain ancestry
    // after parents exit and responsibility attribution moves to another process.
    struct identity identities[LIMIT]; int valid[LIMIT];
    int length = bytes / (int)sizeof(pid_t);
    for(int i=0;i<length;i++) valid[i]=pids[i]>0 && pids[i]!=getpid() && identify(pids[i],&identities[i]);
    int changed;
    do {
      changed=0;
      for(int i=0;i<length;i++) if(valid[i] && !has(identities[i].unique) &&
        (has(identities[i].parent) || responsible(pids[i])==getpid())) {
          remember(identities[i].unique);changed=1;
      }
    } while(changed && known_count<LIMIT);
    for(int i=0;i<length;i++) if(valid[i] && pids[i]!=leader && has(identities[i].unique)) {
      struct proc_bsdinfo bi={0};
      if(proc_pidinfo(pids[i],PROC_PIDTBSDINFO,0,&bi,sizeof(bi))!=sizeof(bi) || bi.pbi_status==SZOMB)continue;
      descendants++;
      if(stopping){struct identity current;if(identify(pids[i],&current)&&current.unique==identities[i].unique)kill(pids[i],SIGKILL);}
    }
    if (stopping) { kill(-leader, SIGKILL); if (!done) kill(leader, SIGKILL); }
    if (done && descendants == 0) { if (++quiet >= 3) break; } else quiet = 0;
    usleep(10000);
  }
  while (waitpid(leader, &status, 0) < 0 && errno == EINTR) {}
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 125;
}
