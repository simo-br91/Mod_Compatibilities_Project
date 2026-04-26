plugins {
    kotlin("jvm") version "2.1.10"
    application
}

repositories {
    mavenCentral()
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass.set("com.modcompat.artifactanalysis.ApplicationKt")
}

dependencies {
    testImplementation(kotlin("test"))
}

