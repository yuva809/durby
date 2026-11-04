plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.durby.printbridge.spike"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.durby.printbridge.spike"
        minSdk = 28 // Android 9 (SUNMI T2s Lite)
        targetSdk = 35
        versionCode = 3
        versionName = "0.0.3"
    }

    buildTypes {
        // Spike only: the debug key signs everything; the real app gets its own signing (open question 4).
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true // BuildConfig.VERSION_NAME: shown in the app, the notification, /health and the test receipt
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
}
