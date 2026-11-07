plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * Release signing (ADR 0032 §13–14). The key file lives in the git-ignored apps/android/release/; its password only
 * in the user's Gradle properties (~/.gradle/gradle.properties), never in this repo:
 *
 *   durbyReleasePassword=<the password in the password manager>
 *   durbyReleaseStoreFile=/absolute/path/to/durby-release.p12   (optional; default apps/android/release/durby-release.p12)
 *
 * PKCS12 has one password for the store and the key. A release build without them fails before it starts.
 */
val releaseAlias = "durby-release"
val releasePassword: String? = providers.gradleProperty("durbyReleasePassword").orNull
val releaseStoreFile: File = providers.gradleProperty("durbyReleaseStoreFile").orNull?.let(::File)
    ?: rootProject.file("release/durby-release.p12")

android {
    namespace = "tech.durby.pos"
    compileSdk = 35

    defaultConfig {
        applicationId = "tech.durby.pos"
        minSdk = 28 // Android 9 (SUNMI T2s Lite)
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        create("release") {
            storeFile = releaseStoreFile
            storePassword = releasePassword
            keyAlias = releaseAlias
            keyPassword = releasePassword
            storeType = "pkcs12"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
    // org.json is part of Android; the JVM unit tests need the real one instead of the stub.
    testImplementation("org.json:json:20240303")
}

tasks.withType<Test>().configureEach {
    // The address rules are one table for the web and the app (ADR 0032 §7).
    systemProperty(
        "durby.addressFixture",
        rootProject.file("../../packages/shared/src/native-print-addresses.json").absolutePath,
    )
}

// Fail early and clearly when a release APK is built without the key, instead of an unsigned or half-signed APK.
// Debug builds and unit tests never need it.
gradle.taskGraph.whenReady {
    val releasePackaging = Regex("^(assemble|bundle|package|install|sign|validateSigning).*Release.*")
    if (allTasks.none { it.project == project && releasePackaging.matches(it.name) }) return@whenReady
    val repoProperties = rootProject.file("gradle.properties")
    if (repoProperties.isFile && repoProperties.readText().contains("durbyRelease")) {
        throw GradleException(
            "durbyRelease* found in ${repoProperties.path}, which is committed. Move it to ~/.gradle/gradle.properties.",
        )
    }
    if (releasePassword.isNullOrEmpty()) {
        throw GradleException(
            "Release signing: durbyReleasePassword is not set. Add it to ~/.gradle/gradle.properties " +
                "(the password in the password manager). See apps/android/app/build.gradle.kts.",
        )
    }
    if (!releaseStoreFile.isFile) {
        throw GradleException(
            "Release signing: no key file at ${releaseStoreFile.path}. Put durby-release.p12 there, or set " +
                "durbyReleaseStoreFile in ~/.gradle/gradle.properties.",
        )
    }
}
