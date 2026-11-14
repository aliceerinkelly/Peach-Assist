#include <jni.h>
#include <string>
#include <cstring>
#include <cstdlib>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>
#include "node.h"

/*
 * The only native code in the app: start Node with a contiguous argv, and send
 * whatever it prints to logcat so a phone with no terminal can still be
 * diagnosed from a PC with adb.
 */

static int pipe_stdout[2];
static int pipe_stderr[2];
static pthread_t thread_stdout;
static pthread_t thread_stderr;
static const char *ADBTAG = "PEACH";

static void *thread_stderr_func(void *) {
    ssize_t n;
    char buf[2048];
    while ((n = read(pipe_stderr[0], buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, buf);
    }
    return 0;
}

static void *thread_stdout_func(void *) {
    ssize_t n;
    char buf[2048];
    while ((n = read(pipe_stdout[0], buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(ANDROID_LOG_INFO, ADBTAG, buf);
    }
    return 0;
}

static int start_redirecting_stdout_stderr() {
    setvbuf(stdout, 0, _IONBF, 0);
    pipe(pipe_stdout);
    dup2(pipe_stdout[1], STDOUT_FILENO);

    setvbuf(stderr, 0, _IONBF, 0);
    pipe(pipe_stderr);
    dup2(pipe_stderr[1], STDERR_FILENO);

    if (pthread_create(&thread_stdout, 0, thread_stdout_func, 0) == -1) return -1;
    pthread_detach(thread_stdout);
    if (pthread_create(&thread_stderr, 0, thread_stderr_func, 0) == -1) return -1;
    pthread_detach(thread_stderr);
    return 0;
}

// libuv wants every argument in one contiguous block.
extern "C" JNIEXPORT jint JNICALL
Java_net_peach_messenger_ServerService_startNodeWithArguments(
        JNIEnv *env, jobject /* this */, jobjectArray arguments) {

    jsize count = env->GetArrayLength(arguments);

    int size = 0;
    for (int i = 0; i < count; i++) {
        const char *a = env->GetStringUTFChars((jstring) env->GetObjectArrayElement(arguments, i), 0);
        size += (int) strlen(a) + 1;
        env->ReleaseStringUTFChars((jstring) env->GetObjectArrayElement(arguments, i), a);
    }

    char *buffer = (char *) calloc(size, sizeof(char));
    char **argv = (char **) calloc(count, sizeof(char *));
    char *cursor = buffer;

    for (int i = 0; i < count; i++) {
        jstring js = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *a = env->GetStringUTFChars(js, 0);
        strncpy(cursor, a, strlen(a));
        argv[i] = cursor;
        cursor += strlen(a) + 1;
        env->ReleaseStringUTFChars(js, a);
    }

    if (start_redirecting_stdout_stderr() == -1) {
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, "could not redirect stdout and stderr to logcat");
    }

    return (jint) node::Start(count, argv);
}
