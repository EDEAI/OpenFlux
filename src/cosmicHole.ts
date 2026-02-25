/**
 * 黑洞/白洞粒子动画效果
 * - 黑洞：粒子围绕中心顺时针旋转，被吸入中心
 * - 白洞：从极暗瞬间爆发，粒子向外涌现
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
    private explosionPhase: number = 0; // 白洞爆发阶段
    private explosionStartTime: number = 0;

    constructor(container: HTMLElement, size: number = 40) {
        this.size = size;
        this.centerX = size / 2;
        this.centerY = size / 2;

        // 创建 Canvas
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
            ? 2 + Math.random() * 3  // 白洞：从中心开始
            : 5 + Math.random() * (this.size / 2 - 8); // 黑洞：随机分布

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
            // 白洞：白色/淡蓝色
            const colors = ['#ffffff', '#e0f0ff', '#b3d9ff'];
            return colors[Math.floor(Math.random() * colors.length)];
        } else {
            // 黑洞：统一深紫色
            const colors = ['#6366f1', '#818cf8', '#a78bfa'];
            return colors[Math.floor(Math.random() * colors.length)];
        }
    }

    private updateParticles(): void {
        const now = Date.now();

        this.particles.forEach((p, index) => {
            if (this.mode === 'loading') {
                // 简单的顺时针旋转
                p.angle += p.speed;
                p.x = this.centerX + Math.cos(p.angle) * p.radius;
                p.y = this.centerY + Math.sin(p.angle) * p.radius;
            } else if (this.mode === 'blackhole') {
                // 黑洞：粒子围绕中心旋转并被吸入
                p.angle += p.speed;
                p.radius -= 0.1; // 逐渐被吸入
                p.alpha = Math.min(1, p.radius / (this.size / 4));

                if (p.radius < 2) {
                    // 重生粒子
                    this.particles[index] = this.createParticle();
                }

                p.x = this.centerX + Math.cos(p.angle) * p.radius;
                p.y = this.centerY + Math.sin(p.angle) * p.radius;
            } else if (this.mode === 'whitehole') {
                // 白洞：从中心爆发向外
                const timeSinceExplosion = now - this.explosionStartTime;

                if (this.explosionPhase === 0 && timeSinceExplosion < 200) {
                    // 极暗阶段：所有粒子聚集在中心
                    p.radius = 2;
                    p.alpha = 0.1;
                } else if (this.explosionPhase === 0) {
                    // 切换到爆发阶段
                    this.explosionPhase = 1;
                    this.particles.forEach(particle => {
                        particle.radius = 2;
                        particle.speed = 0.5 + Math.random() * 1;
                        particle.color = this.getParticleColor();
                    });
                }

                if (this.explosionPhase === 1) {
                    // 爆发阶段：粒子向外涌现
                    p.angle += 0.02;
                    p.radius += p.speed;
                    p.alpha = Math.max(0, 1 - (p.radius / (this.size / 2)));

                    if (p.radius > this.size / 2) {
                        // 重生粒子继续爆发
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
        // 清空画布
        this.ctx.clearRect(0, 0, this.size, this.size);

        // 绘制中心
        if (this.mode === 'blackhole') {
            // 黑洞中心
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
            // 白洞中心发光
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
            // Loading 中心点
            this.ctx.fillStyle = 'rgba(99, 102, 241, 0.5)';
            this.ctx.beginPath();
            this.ctx.arc(this.centerX, this.centerY, 3, 0, Math.PI * 2);
            this.ctx.fill();
        }

        // 绘制粒子
        this.particles.forEach(p => {
            this.ctx.save();
            this.ctx.globalAlpha = p.alpha;
            this.ctx.fillStyle = p.color;
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            this.ctx.fill();

            // 粒子拖尾效果
            if (this.mode !== 'loading') {
                const tailLength = this.mode === 'blackhole' ? 3 : 5;
                const tailAngle = this.mode === 'blackhole'
                    ? p.angle - 0.3
                    : p.angle + Math.PI; // 白洞拖尾朝中心
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

        // Loading 模式：绘制旋转弧线
        if (this.mode === 'loading') {
            const rotation = (Date.now() / 1000) * Math.PI; // 顺时针旋转
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
            // 重置白洞爆发状态
            this.explosionPhase = 0;
            this.explosionStartTime = Date.now();
            this.particles.forEach(p => {
                p.radius = 2;
                p.alpha = 0.1;
            });
        } else if (mode === 'blackhole' && prevMode !== 'blackhole') {
            // 重新初始化黑洞粒子
            this.initParticles();
        }

        // 更新粒子颜色
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

// 创建全局 typing indicator 实例
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
