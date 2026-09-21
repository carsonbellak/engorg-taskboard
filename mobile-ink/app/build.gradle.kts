import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Decode the committed base64 debug keystore so every build — CI and local — signs with
// the SAME fixed SHA-1 (registered with Firebase for native Google Sign-In). Without a
// fixed keystore, each CI build gets a random SHA-1 and Google Sign-In (error 10) breaks.
val ksB64 = file("debug-keystore.b64")
val ksFile = file("debug.keystore")
if (ksB64.exists() && !ksFile.exists()) {
    ksFile.writeBytes(Base64.getMimeDecoder().decode(ksB64.readText()))
}

// The Firebase project's OAuth "Web client ID" (public, not a secret). Set it in
// gradle.properties as WEB_CLIENT_ID=... ; native sign-in requests an ID token for it.
val webClientId = (findProperty("WEB_CLIENT_ID") as String?) ?: ""

android {
    namespace = "com.engorg.inkpad"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.engorg.inkpad"
        minSdk = 24
        targetSdk = 35
        // Auto-increment per CI build so every published APK is a proper update — a hardcoded
        // versionCode makes Android's installer treat new APKs as "not an update" and silently
        // keep the old app (which stranded users on stale import code). Local builds get 101.
        versionCode = (System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1) + 100
        versionName = "1.3.28"
        buildConfigField("String", "WEB_CLIENT_ID", "\"$webClientId\"")
    }

    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
    // Jetpack Ink — Google's low-latency stylus library (front-buffered rendering).
    val inkVersion = "1.0.0"
    implementation("androidx.ink:ink-authoring:$inkVersion")
    implementation("androidx.ink:ink-brush:$inkVersion")
    implementation("androidx.ink:ink-geometry:$inkVersion")
    implementation("androidx.ink:ink-nativeloader:$inkVersion")
    implementation("androidx.ink:ink-rendering:$inkVersion")
    implementation("androidx.ink:ink-strokes:$inkVersion")

    // Motion prediction — draws a predicted lead ahead of the pen to cut perceived latency.
    implementation("androidx.input:input-motionprediction:1.0.0")

    // Native Google Sign-In (bridged into the WebView's Firebase session).
    implementation("com.google.android.gms:play-services-auth:21.2.0")

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
