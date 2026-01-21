-- Sample AI Learning Content for Testing

-- NVIDIA GPU Architecture Blueprint
INSERT INTO ai_learning_content (
  title, content_type, content, summary, author_company, author_name,
  version, tags, category, difficulty, is_featured, is_nvidia_content,
  external_url
) VALUES (
  'NVIDIA H100 GPU Architecture Deep Dive',
  'blueprint',
  '# NVIDIA H100 GPU Architecture Blueprint

## Overview
The NVIDIA H100 Tensor Core GPU represents a breakthrough in AI and HPC performance, built on the NVIDIA Hopper architecture.

## Key Specifications
- **Process**: TSMC 4N
- **Transistors**: 80 billion
- **Memory**: Up to 80GB HBM3
- **Memory Bandwidth**: 3TB/s
- **AI Performance**: 1000 TOPS INT8

## Architecture Components

### Streaming Multiprocessors (SM)
- 4th Gen Tensor Cores
- Enhanced RT Cores
- Improved cache hierarchy

### Memory Subsystem
- HBM3 memory with up to 80GB capacity
- L2 cache up to 50MB
- Memory compression technology

### Tensor Cores
- Support for FP8, BF16, FP16, TF32, and INT8
- Sparsity support for 2:4 structured sparse networks
- Hardware acceleration for transformer models

## Programming Model
- CUDA 11.8+ compatibility
- Hopper-specific optimizations
- Support for multi-instance GPU (MIG)

## Performance Benchmarks
- MLPerf Training v2.0 leader
- Up to 9x faster than A100 for large language models
- Exceptional performance for recommendation systems',
  'Comprehensive technical blueprint covering NVIDIA H100 GPU architecture, specifications, and programming model for AI developers.',
  'NVIDIA',
  'NVIDIA Architecture Team',
  '1.2',
  '["GPU", "H100", "Tensor Core", "AI", "CUDA", "Architecture", "HPC"]',
  'Hardware',
  'advanced',
  1,
  1,
  'https://www.nvidia.com/en-us/data-center/h100/'
);

-- Research Paper on Transformer Optimization
INSERT INTO ai_learning_content (
  title, content_type, content, summary, author_company, author_name,
  version, tags, category, difficulty, is_featured
) VALUES (
  'FlashAttention-2: Faster Attention with Better Parallelism',
  'paper',
  '# FlashAttention-2: Faster Attention with Better Parallelism

## Abstract
We introduce FlashAttention-2, an improved version of FlashAttention that achieves 2x speedup over the original algorithm through better work partitioning and parallelism.

## Introduction
Attention mechanisms are fundamental to transformer models but suffer from quadratic complexity in sequence length. FlashAttention addressed this through memory-efficient attention computation, and FlashAttention-2 further optimizes this approach.

## Key Improvements

### 1. Better Work Partitioning
- Improved parallelization across sequence length dimension
- Reduced communication overhead between thread blocks
- Better load balancing across streaming multiprocessors

### 2. Optimized Memory Access Patterns
- Tuned tile sizes for different hardware configurations
- Minimized global memory transactions
- Improved cache utilization

### 3. Hardware-Aware Optimizations
- GPU-specific optimizations for A100 and H100
- Tensor Core utilization improvements
- Reduced register pressure

## Performance Results
- 2x speedup over FlashAttention on H100
- Scales efficiently with sequence length up to 64K tokens
- Maintains numerical accuracy with FP16 and BF16

## Implementation Details
Available in the official Flash Attention repository with CUDA kernels optimized for modern GPU architectures.',
  'Technical paper describing FlashAttention-2 algorithm improvements for efficient transformer attention computation.',
  'Stanford University',
  'Tri Dao',
  '2.0',
  '["Attention", "Transformer", "CUDA", "GPU", "Memory Efficiency", "Optimization"]',
  'Research',
  'advanced',
  1
);