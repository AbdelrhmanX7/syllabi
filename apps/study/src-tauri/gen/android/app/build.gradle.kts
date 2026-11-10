import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val playStore = System.getenv("STUDY_STORE") == "play"

android {
    compileSdk = 36
    namespace = "studio.syllabi.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "studio.syllabi.app"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        // Read by MainActivity: false = Google Play build, no in-app updater.
        buildConfigField("boolean", "SELF_UPDATE", (!playStore).toString())
    }
    // Google Play build (STUDY_STORE=play, set by scripts/build-play.mjs): the release manifest gets the
    // src/play overlay, which removes the installer permission, the update file provider and
    // USE_EXACT_ALARM. Every other build (the sideloaded APK) keeps self-update. A build-type source
    // set, not a product flavor: RustPlugin's abi flavors and the tauri CLI's task names stay as they are.
    if (playStore) {
        sourceSets.getByName("release").manifest.srcFile("src/play/AndroidManifest.xml")
    }
    // Release signing from environment variables, never from a committed file. The SAME keystore and
    // env file loaded by scripts/android-release.mjs (default ~/.android/syllabi-release.env, mode 600):
    //   SYLLABI_KEYSTORE          absolute path to the .jks (PKCS12)
    //   SYLLABI_KEYSTORE_PASSWORD / SYLLABI_KEY_ALIAS / SYLLABI_KEY_PASSWORD
    // Losing that keystore means every installed tablet must uninstall before the next update.
    System.getenv("SYLLABI_KEYSTORE")?.takeIf { it.isNotBlank() && file(it).exists() }?.let { keystorePath ->
        signingConfigs {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("SYLLABI_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SYLLABI_KEY_ALIAS") ?: "syllabi"
                keyPassword = System.getenv("SYLLABI_KEY_PASSWORD") ?: System.getenv("SYLLABI_KEYSTORE_PASSWORD")
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            // Signed only when the release env is loaded (scripts/android-release.mjs sources
            // ~/.android/syllabi-release.env); otherwise gradle emits the usual `-unsigned` APK.
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
        // ML Kit digital-ink-recognition 19.0.0 ships Kotlin 2.1 module metadata; this project's
        // Kotlin 1.9 compiler refuses to read it. InkRecognizer.kt uses only ML Kit's Java API, so
        // skipping the metadata version check is safe (drop it once kotlin-gradle-plugin is >= 2.1).
        freeCompilerArgs += listOf("-Xskip-metadata-version-check")
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // On-device handwriting recognition (InkRecognizer.kt); models download at runtime, ~20 MB/language.
    implementation("com.google.mlkit:digital-ink-recognition:19.0.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
