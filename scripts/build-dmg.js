const { execSync } = require('child_process');

// Check if --i flag is present in arguments
const shouldIncrement = process.argv.includes('--i');

try {
    if (shouldIncrement) {
        console.log('🚀 Incrementing version...');
        execSync('npm version patch --no-git-tag-version', { stdio: 'inherit' });
    }

    console.log('🏗️  Building application...');
    execSync('npm run build', { stdio: 'inherit' });

    console.log('📦 Packaging DMG...');
    execSync('electron-builder --mac dmg', { stdio: 'inherit' });

    console.log('✅ DMG build complete!');
} catch (error) {
    console.error('❌ Build failed:', error.message);
    process.exit(1);
}
