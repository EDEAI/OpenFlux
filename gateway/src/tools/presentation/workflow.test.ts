import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PresentationWorkflowState } from './workflow';
import { evaluatePresentationCompletion } from './workflow';

function state(pptx: string): PresentationWorkflowState {
    return {
        version: 1,
        designId: 'design-completion-test',
        updatedAt: Date.now(),
        stage: 'visual_review',
        contentDirection: { complete: true, narrativeArc: ['a', 'b', 'c'], slideCount: 3 },
        designSample: {
            required: true,
            status: 'approved',
            mode: 'auto',
            sampleSlideNumbers: [1, 2, 3],
        },
        fullGeneration: {
            generatedAt: Date.now(),
            slideCount: 3,
            pptx,
            requirePdf: false,
            nativeQaAvailable: true,
            imageQaAvailable: true,
            imageQaChecked: 0,
            imageQaErrors: 0,
        },
        visualReview: {
            status: 'pending',
            reviewedSlideNumbers: [],
            totalSlides: 3,
            issues: [],
        },
        qa: { status: 'passed', issues: [], errors: 0, warnings: 0, revision: 0 },
        outputs: { pptx },
    };
}

test('presentation completion predicate requires all-slide visual review evidence', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-predicate-'));
    try {
        const pptx = join(root, 'deck.pptx');
        await fs.writeFile(pptx, 'pptx');
        const workflow = state(pptx);
        let result = await evaluatePresentationCompletion(workflow);
        assert.equal(result.complete, false);
        assert.ok(result.missing.includes('not_all_slides_reviewed'));
        assert.deepEqual(result.files, []);

        workflow.visualReview.status = 'complete';
        workflow.visualReview.reviewedSlideNumbers = [1, 2, 3];
        workflow.stage = 'packaging';
        result = await evaluatePresentationCompletion(workflow);
        assert.equal(result.complete, true);
        assert.deepEqual(result.files, [pptx]);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('presentation completion predicate blocks unavailable or failing image geometry QA', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-image-predicate-'));
    try {
        const pptx = join(root, 'deck.pptx');
        await fs.writeFile(pptx, 'pptx');
        const workflow = state(pptx);
        workflow.visualReview.status = 'complete';
        workflow.visualReview.reviewedSlideNumbers = [1, 2, 3];
        workflow.stage = 'packaging';

        workflow.fullGeneration!.imageQaAvailable = false;
        let result = await evaluatePresentationCompletion(workflow);
        assert.equal(result.complete, false);
        assert.ok(result.missing.includes('image_geometry_qa_unavailable'));

        workflow.fullGeneration!.imageQaAvailable = true;
        workflow.fullGeneration!.imageQaErrors = 1;
        workflow.qa.status = 'needs_revision';
        workflow.qa.errors = 1;
        result = await evaluatePresentationCompletion(workflow);
        assert.equal(result.complete, false);
        assert.ok(result.missing.includes('image_qa_errors_remain'));
        assert.equal(result.nextAction, 'patch_review_errors');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
