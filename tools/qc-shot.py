#!/usr/bin/env python3

import argparse
import os
from PIL import Image

def main():
    parser = argparse.ArgumentParser(description='Post-process macOS screencapture PNG for README')
    parser.add_argument('input', help='Input PNG file path')
    parser.add_argument('output', help='Output PNG file path')
    parser.add_argument('--width', type=int, help='Target width in pixels')
    parser.add_argument('--radius', type=int, default=12, help='Corner radius in pixels (default: 12)')
    
    args = parser.parse_args()
    
    if not os.path.exists(args.input):
        print(f"Error: Input file '{args.input}' does not exist.", file=sys.stderr)
        return 1
    
    # Open and convert to RGBA
    with Image.open(args.input) as img:
        img = img.convert('RGBA')
        
        # Resize if needed
        if args.width:
            original_width, original_height = img.size
            aspect_ratio = original_height / original_width
            new_height = round(args.width * aspect_ratio)
            img = img.resize((args.width, new_height), Image.LANCZOS)
        
        # Create rounded corners mask
        width, height = img.size
        mask = Image.new('L', (width * 4, height * 4), 0)
        draw = ImageDraw.Draw(mask)
        draw.rounded_rectangle(
            (0, 0, width * 4 - 1, height * 4 - 1),
            radius=args.radius * 4,
            fill=255
        )
        mask = mask.resize((width, height), Image.LANCZOS)
        
        # Apply mask to alpha channel
        img.putalpha(mask)
        
        # Save output
        img.save(args.output, 'PNG')
        
        print(f"{args.output} {width}x{height}")
    
    return 0

if __name__ == '__main__':
    import sys
    from PIL import ImageDraw
    exit(main())
