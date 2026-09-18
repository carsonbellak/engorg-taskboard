plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.engorg.inkpad"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.engorg.inkpad"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1-poc"
    }

    buildTypes {
        // Debug builds are auto-signed with the debug keystore, so the APK sideloads
        // without any signing setup.
        release {
            isMinifyEnabled = false
        }
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
    // Jetpack Ink — Google's low-latency stylus library (front-buffered rendering).
    // Pinned to the stable 1.0.0 release (verified on Google's Maven repo).
    val inkVersion = "1.0.0"
    implementation("androidx.ink:ink-authoring:$inkVersion")
    implementation("androidx.ink:ink-brush:$inkVersion")
    implementation("androidx.ink:ink-geometry:$inkVersion")
    implementation("androidx.ink:ink-nativeloader:$inkVersion")
    implementation("androidx.ink:ink-rendering:$inkVersion")
    implementation("androidx.ink:ink-strokes:$inkVersion")

    // Motion prediction — draws a predicted lead ahead of the pen to cut perceived latency.
    implementation("androidx.input:input-motionprediction:1.0.0")

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
