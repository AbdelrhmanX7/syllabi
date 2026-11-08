import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """node""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )
                
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    // The template calls back into the Tauri CLI through the package manager that ran `android init`
    // (`npm run tauri …` / `yarn tauri …`). This machine has only `node` on PATH (the npm/yarn/pnpm
    // shims are dangling), so the CLI's own entry script is located by walking up from the working
    // dir to the nearest `node_modules/@tauri-apps/cli/tauri.js` — hoisted (yarn/npm) and
    // per-package (pnpm) layouts both resolve — and run with `node` directly.
    private fun resolveTauriCli(from: File): File {
        var dir: File? = from.canonicalFile
        while (dir != null) {
            val candidate = File(dir, "node_modules/@tauri-apps/cli/tauri.js")
            if (candidate.isFile) return candidate
            dir = dir.parentFile
        }
        throw GradleException("@tauri-apps/cli not found above ${from.absolutePath} — install the JS dependencies first")
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val workingDir = File(project.projectDir, rootDirRel)
        val args = listOf(resolveTauriCli(workingDir).absolutePath, "android", "android-studio-script");

        project.exec {
            workingDir(workingDir)
            executable(executable)
            args(args)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}