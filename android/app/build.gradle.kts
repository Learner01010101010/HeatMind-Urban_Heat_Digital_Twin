plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.heatmind.twin"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.heatmind.twin"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        // Where the app loads the twin from.
        //
        // Overridable per build so the same source runs against a laptop dev server
        // and against production without editing code:
        //
        //   ./gradlew assembleDebug -PheatmindUrl=http://10.0.2.2:3000
        //
        // 10.0.2.2 is the emulator's alias for the host machine. On a physical
        // device use the laptop's LAN address, or `adb reverse tcp:3000 tcp:3000`
        // and keep localhost. See android/README.md.
        val heatmindUrl = (project.findProperty("heatmindUrl") as String?)
            ?: "http://10.0.2.2:3000"
        buildConfigField("String", "HEATMIND_URL", "\"$heatmindUrl\"")
    }

    buildTypes {
        debug {
            // The dev server is plain HTTP; see network_security_config.xml, which
            // permits cleartext to loopback and private ranges only.
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        viewBinding = true
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
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("com.google.android.material:material:1.12.0")
}
