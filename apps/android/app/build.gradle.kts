plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

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
