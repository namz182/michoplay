import java.util.Properties
import java.io.FileInputStream
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.OutputDirectory

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

abstract class PrepareAndroidDownloader : Exec() {
    @get:OutputDirectory
    abstract val resourceDirectory: DirectoryProperty
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
val releaseKeystorePropertiesFile = rootProject.file("keystore.properties")
val releaseKeystoreProperties = Properties().apply {
    if (releaseKeystorePropertiesFile.exists()) {
        FileInputStream(releaseKeystorePropertiesFile).use { load(it) }
    }
}

android {
    compileSdk = 37
    namespace = "app.michoplay.desktop"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.michoplay.desktop"
        minSdk = 26
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (releaseKeystorePropertiesFile.exists()) {
            create("release") {
                keyAlias = releaseKeystoreProperties.getProperty("keyAlias")
                keyPassword = releaseKeystoreProperties.getProperty("keyPassword")
                storeFile = file(releaseKeystoreProperties.getProperty("storeFile"))
                storePassword = releaseKeystoreProperties.getProperty("storePassword")
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
            // Use the private release key when configured; otherwise keep local APKs installable.
            // Replace the fallback with a private keystore before distributing a production build.
            signingConfig = signingConfigs.getByName(
                if (releaseKeystorePropertiesFile.exists()) "release" else "debug"
            )
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    // The wrapper carries Python and QuickJS; FFmpeg must track its current release.
    implementation("io.github.junkfood02.youtubedl-android:library:latest.release")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:latest.release")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

configurations.configureEach {
    resolutionStrategy.cacheDynamicVersionsFor(0, "seconds")
}

val prepareAndroidDownloader by tasks.registering(PrepareAndroidDownloader::class) {
    val script = rootProject.file("../../../scripts/prepare-android-tools.mjs")
    resourceDirectory.set(layout.buildDirectory.dir("generated/downloader/res"))
    inputs.file(script)
    outputs.upToDateWhen { false }
    commandLine("node", script.absolutePath, resourceDirectory.get().asFile.absolutePath)
}
tasks.named("preBuild").configure { dependsOn(prepareAndroidDownloader) }
androidComponents {
    onVariants(selector().all()) { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(prepareAndroidDownloader) { it.resourceDirectory }
    }
}

apply(from = file("tauri.build.gradle.kts"))
