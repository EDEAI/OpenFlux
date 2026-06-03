/**
 * Black hole / white hole particle animation
 * - Black hole: particles rotate clockwise around the center and are sucked in
 * - White hole: bursts from near-total darkness, particles surge outward
 */

interface Particle {
    x: number;
    y: number;
    angle: number;
    radius: number;
    speed: number;
    size: number;
    alpha: number;
    color: string;
}

export class CosmicHole {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private particles: Particle[] = [];
    private animationId: number | null = null;
    private mode: 'blackhole' | 'whitehole' | 'loading' = 'loading';
    private centerX: number;
    private centerY: number;
    private size: number;
    private explosionPhase: number = 0; // white hole explosion phase
    private explosionStartTime: number = 0;

    constructor(container: HTMLElement, size: number = 40) {
        this.size = size;
        this.centerX = size / 2;
        this.centerY = size / 2;

        // Create the Canvas
        this.canvas = document.createElement('canvas');
        this.canvas.width = size;
        this.canvas.height = size;
        this.canvas.style.width = `${size}px`;
        this.canvas.style.height = `${size}px`;
        container.appendChild(this.canvas);

        this.ctx = this.canvas.getContext('2d')!;
        this.initParticles();
    }

    private initParticles(): void {
        this.particles = [];
        const particleCount = 30;

        for (let i = 0; i < particleCount; i++) {
            this.particles.push(this.createParticle());
        }
    }

    private createParticle(forExplosion: boolean = false): Particle {
        const angle = Math.random() * Math.PI * 2;
        const radius = forExplosion
            ? 2 + Math.random() * 3  // white hole: start from the center
            : 5 + Math.random() * (this.size / 2 - 8); // black hole: random distribution

        return {
            x: 0,
            y: 0,
            angle,
            radius,
            speed: 0.02 + Math.random() * 0.03,
            size: 1 + Math.random() * 2,
            alpha: 0.3 + Math.random() * 0.7,
            color: this.getParticleColor(),
        };
    }

    private getParticleColor(): string {
        if (this.mode === 'whitehole') {
            // white hole: white / light blue
            const colors = ['#ffffff', '#e0f0ff', '#b3d9ff'];
            return colors[Math.floor(Math.random() * colors.length)];
        } else {
            // black hole: uniform deep purple
            const colors = ['#6366f1', '#818cf8', '#a78bfa'];
            return colors[Math.floor(Math.random() * colors.length)];
        }
    }

    private updateParticles(): void {
        const now = Date.now();

        this.particles.forEach((p, index) => {
            if (this.mode === 'loading') {
                // Simple clockwise rotation
                p.angle += p.speed;
                p.x = this.centerX + Math.cos(p.angle) * p.radius;
                p.y = this.centerY + Math.sin(p.angle) * p.radius;
            } else if (this.mode === 'blackhole') {
                // black hole: particles rotate around the center and get sucked in
                p.angle += p.speed;
                p.radius -= 0.1; // gradually sucked in
                p.alpha = Math.min(1, p.radius / (this.size / 4));

                if (p.radius < 2) {
                    // Respawn the particle
                    this.particles[index] = this.createParticle();
                }

                p.x = this.centerX + Math.cos(p.angle) * p.radius;
                p.y = this.centerY + Math.sin(p.angle) * p.radius;
            } else if (this.mode === 'whitehole') {
                // white hole: bursts outward from the center
                const timeSinceExplosion = now - this.explosionStartTime;

                if (this.explosionPhase === 0 && timeSinceExplosion < 200) {
                    // Near-dark phase: all particles gather at the center
                    p.radius = 2;
                    p.alpha = 0.1;
                } else if (this.explosionPhase === 0) {
                    // Switch to the explosion phase
                    this.explosionPhase = 1;
                    this.particles.forEach(particle => {
                        particle.radius = 2;
                        particle.speed = 0.5 + Math.random() * 1;
                        particle.color = this.getParticleColor();
                    });
                }

                if (this.explosionPhase === 1) {
                    // Explosion phase: particles surge outward
                    p.angle += 0.02;
                    p.radius += p.speed;
                    p.alpha = Math.max(0, 1 - (p.radius / (this.size / 2)));

                    if (p.radius > this.size / 2) {
                        // Respawn the particle to keep the explosion going
                        this.particles[index] = this.createParticle(true);
                        this.particles[index].speed = 0.3 + Math.random() * 0.8;
                        this.particles[index].color = this.getParticleColor();
                    }
                }

                p.x = this.centerX + Math.cos(p.angle) * p.radius;
                p.y = this.centerY + Math.sin(p.angle) * p.radius;
            }
        });
    }

    private draw(): void {
        // Clear the canvas
        this.ctx.clearRect(0, 0, this.size, this.size);

        // Draw the center
        if (this.mode === 'blackhole') {
            // Black hole center
            const gradient = this.ctx.createRadialGradient(
                this.centerX, this.centerY, 0,
                this.centerX, this.centerY, 8
            );
            gradient.addColorStop(0, '#000000');
            gradient.addColorStop(0.5, '#1a0a2e');
            gradient.addColorStop(1, 'transparent');
            this.ctx.fillStyle = gradient;
            this.ctx.beginPath();
            this.ctx.arc(this.centerX, this.centerY, 8, 0, Math.PI * 2);
            this.ctx.fill();
        } else if (this.mode === 'whitehole' && this.explosionPhase === 1) {
            // White hole center glow
            const gradient = this.ctx.createRadialGradient(
                this.centerX, this.centerY, 0,
                this.centerX, this.centerY, 10
            );
            gradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
            gradient.addColorStop(0.3, 'rgba(200, 230, 255, 0.6)');
            gradient.addColorStop(1, 'transparent');
            this.ctx.fillStyle = gradient;
            this.ctx.beginPath();
            this.ctx.arc(this.centerX, this.centerY, 10, 0, Math.PI * 2);
            this.ctx.fill();
        } else if (this.mode === 'loading') {
            // Loading center dot
            this.ctx.fillStyle = 'rgba(99, 102, 241, 0.5)';
            this.ctx.beginPath();
            this.ctx.arc(this.centerX, this.centerY, 3, 0, Math.PI * 2);
            this.ctx.fill();
        }

        // Draw the particles
        this.particles.forEach(p => {
            this.ctx.save();
            this.ctx.globalAlpha = p.alpha;
            this.ctx.fillStyle = p.color;
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            this.ctx.fill();

            // Particle trail effect
            if (this.mode !== 'loading') {
                const tailLength = this.mode === 'blackhole' ? 3 : 5;
                const tailAngle = this.mode === 'blackhole'
                    ? p.angle - 0.3
                    : p.angle + Math.PI; // white hole trail points toward the center
                for (let i = 1; i <= tailLength; i++) {
                    const tailRadius = this.mode === 'blackhole'
                        ? p.radius + i * 2
                        : p.radius - i * 2;
                    const tailX = this.centerX + Math.cos(tailAngle + i * 0.1) * tailRadius;
                    const tailY = this.centerY + Math.sin(tailAngle + i * 0.1) * tailRadius;
                    this.ctx.globalAlpha = p.alpha * (1 - i / (tailLength + 1));
                    this.ctx.beginPath();
                    this.ctx.arc(tailX, tailY, p.size * 0.6, 0, Math.PI * 2);
                    this.ctx.fill();
                }
            }
            this.ctx.restore();
        });

        // Loading mode: draw a rotating arc
        if (this.mode === 'loading') {
            const rotation = (Date.now() / 1000) * Math.PI; // clockwise rotation
            this.ctx.save();
            this.ctx.strokeStyle = 'rgba(99, 102, 241, 0.8)';
            this.ctx.lineWidth = 2;
            this.ctx.lineCap = 'round';
            this.ctx.beginPath();
            this.ctx.arc(
                this.centerX,
                this.centerY,
                this.size / 2 - 5,
                rotation,
                rotation + Math.PI * 1.5
            );
            this.ctx.stroke();
            this.ctx.restore();
        }
    }

    private animate = (): void => {
        this.updateParticles();
        this.draw();
        this.animationId = requestAnimationFrame(this.animate);
    };

    public start(): void {
        if (!this.animationId) {
            this.animate();
        }
    }

    public stop(): void {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    public setMode(mode: 'blackhole' | 'whitehole' | 'loading'): void {
        const prevMode = this.mode;
        this.mode = mode;

        if (mode === 'whitehole' && prevMode !== 'whitehole') {
            // Reset the white hole explosion state
            this.explosionPhase = 0;
            this.explosionStartTime = Date.now();
            this.particles.forEach(p => {
                p.radius = 2;
                p.alpha = 0.1;
            });
        } else if (mode === 'blackhole' && prevMode !== 'blackhole') {
            // Re-initialize the black hole particles
            this.initParticles();
        }

        // Update particle colors
        this.particles.forEach(p => {
            p.color = this.getParticleColor();
        });
    }

    public destroy(): void {
        this.stop();
        this.canvas.remove();
    }

    public getCanvas(): HTMLCanvasElement {
        return this.canvas;
    }
}

// Create the global typing indicator instance
let typingHoleInstance: CosmicHole | null = null;

export function createTypingHole(container: HTMLElement): CosmicHole {
    typingHoleInstance = new CosmicHole(container, 40);
    typingHoleInstance.start();
    return typingHoleInstance;
}

export function setTypingMode(mode: 'blackhole' | 'whitehole' | 'loading'): void {
    if (typingHoleInstance) {
        typingHoleInstance.setMode(mode);
    }
}

export function destroyTypingHole(): void {
    if (typingHoleInstance) {
        typingHoleInstance.destroy();
        typingHoleInstance = null;
    }
}
